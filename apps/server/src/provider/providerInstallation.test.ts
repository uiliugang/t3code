import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings as ServerSettingsValue,
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  type ProviderInstallState,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as ClaudeInstallation from "./ClaudeInstallation.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstallation from "./providerInstallation.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";

const instanceId = ProviderInstanceId.make("antigravity");
const driver = ProviderDriverKind.make("antigravity");
const state: ProviderInstallState = {
  driver,
  operationId: null,
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: null,
  installedVersion: null,
  canRemove: false,
  message: null,
};

function instance(kind = driver, id = instanceId): ProviderInstance {
  return {
    instanceId: id,
    driverKind: kind,
    enabled: false,
    displayName: undefined,
    continuationIdentity: { driverKind: kind, continuationKey: instanceId },
    get orchestrationAdapter(): never {
      throw new Error("Installation must not start a provider session.");
    },
    get snapshot(): never {
      throw new Error("Installation routing must not probe the provider.");
    },
    get textGeneration(): never {
      throw new Error("Installation must not generate text.");
    },
  };
}

const makeHarness = Effect.fn("providerInstallation.test.makeHarness")(function* (
  input: {
    instance?: ProviderInstance;
    others?: ReadonlyArray<ProviderInstance>;
    settings?: Parameters<typeof ServerSettings.layerTest>[0];
    secretValue?: string | undefined;
    settingsRef?: SubscriptionRef.SubscriptionRef<ServerSettingsValue>;
    rebuilding?: boolean;
    missingLocalRuntime?: boolean;
    policy?: Parameters<typeof ServerSettings.layerTest>[1];
  } = {},
) {
  const calls: string[] = [];
  const refreshed = yield* Deferred.make<void>();
  const lastRefreshes = yield* Queue.unbounded<void>();
  const observed = yield* Deferred.make<void>();
  const listening = yield* Deferred.make<void>();
  const installationState = yield* SubscriptionRef.make(state);
  let protectedPaths: ReadonlyArray<string> = [];
  let installationEnvironment: NodeJS.ProcessEnv | undefined;
  const configured = input.instance ?? instance();
  const all = [configured, ...(input.others ?? [])];
  const refreshedInstances: ProviderInstanceId[] = [];
  let watches = 0;
  const dependencies = Layer.mergeAll(
    Layer.mock(SecretResolver.SecretResolver)({
      read: (references) => Effect.succeed(references.map(() => input.secretValue)),
    }),
    Layer.mock(ClaudeInstallation.ClaudeInstallation)({
      start: (env) =>
        Effect.sync(() => {
          installationEnvironment = env;
          calls.push("claude-start");
          return { ...state, driver: ProviderDriverKind.make("claudeAgent") };
        }),
      cancel: () => Effect.succeed(state),
      remove: () => Effect.void,
      state: Effect.succeed(state),
      changes: Stream.succeed(state),
    }),
    input.settingsRef
      ? Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: SubscriptionRef.get(input.settingsRef),
          subscribeChanges: Effect.succeed(SubscriptionRef.changes(input.settingsRef)),
        })
      : ServerSettings.layerTest(input.settings, input.policy),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: (id) =>
        Effect.succeed(input.rebuilding ? undefined : all.find((entry) => entry.instanceId === id)),
      listInstances: Effect.succeed(all),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      refreshInstance: (id) =>
        Effect.sync(() => {
          calls.push("refresh");
          refreshedInstances.push(id);
          return [];
        }).pipe(
          Effect.tap(() => Deferred.succeed(refreshed, undefined)),
          Effect.tap(() =>
            id === all.at(-1)?.instanceId ? Queue.offer(lastRefreshes, undefined) : Effect.void,
          ),
        ),
    }),
    Layer.mock(CodexInstallation.CodexInstallation)({
      managedDirectory: "/unused-managed-codex",
      resolve: (source, binaryPath, environment) =>
        source === "managed" || input.missingLocalRuntime
          ? Effect.fail(
              new CodexInstallation.CodexInstallationError({
                operation: "resolve",
                detail: source === "managed" ? "No managed runtime" : "Local runtime not found",
              }),
            )
          : Effect.succeed({
              source: "local" as const,
              version: "0.169.0",
              executablePath:
                binaryPath === "instance-codex"
                  ? `${environment?.PATH}/instance-codex`
                  : (binaryPath ?? "/custom/codex"),
              managedVersionDirectory: null,
            }),
      startManaged: Effect.die("Unexpected managed installation"),
      start: Effect.sync(() => {
        calls.push("codex-start");
        return { ...state, driver: ProviderDriverKind.make("codex") };
      }),
      cancel: () =>
        Effect.sync(() => {
          calls.push("codex-cancel");
          return { ...state, driver: ProviderDriverKind.make("codex") };
        }),
      state: Effect.succeed({
        ...state,
        driver: ProviderDriverKind.make("codex"),
        source: "managed",
        phase: "downloading",
        operationId: "managed-install",
        downloadedBytes: 16,
        totalBytes: 32,
      }),
      changes: Stream.succeed({
        ...state,
        driver: ProviderDriverKind.make("codex"),
        source: "local",
        installedVersion: "0.169.0",
        executablePath: "/path/codex",
      }),
      checkForUpdate: Effect.void,
      remove: (paths) =>
        Effect.sync(() => {
          protectedPaths = paths ?? [];
          calls.push("codex-remove");
        }),
    }),
    Layer.mock(AntigravityInstallation.AntigravityInstallation)({
      managedDirectory: "/unused-managed-runtime",
      checkForUpdate: Effect.void,
      start: Effect.sync(() => {
        calls.push("start");
        return { ...state, operationId: "install-1", phase: "downloading" as const };
      }).pipe(Effect.tap((started) => SubscriptionRef.set(installationState, started))),
      cancel: () =>
        Effect.sync(() => {
          calls.push("cancel");
          return state;
        }),
      state: Effect.succeed(state),
      changes: all.some((entry) => entry.refreshModels)
        ? SubscriptionRef.changes(installationState).pipe(
            Stream.onStart(
              Effect.sync(() => {
                watches++;
              }),
            ),
            Stream.tap(() => Deferred.succeed(listening, undefined)),
            Stream.ensuring(Deferred.succeed(observed, undefined)),
          )
        : Stream.succeed(state),
      remove: (paths) =>
        Effect.sync(() => {
          protectedPaths = paths ?? [];
          calls.push("remove");
        }),
    }),
  );
  const context = yield* Layer.build(ProviderInstallation.layer.pipe(Layer.provide(dependencies)));
  const connect = Effect.service(ProviderInstallation.ProviderInstallation).pipe(
    Effect.provide(context),
  );
  const router = yield* connect;
  return {
    router,
    connect,
    listening,
    calls,
    refreshed,
    lastRefreshes,
    watches: () => watches,
    observed,
    installationState,
    refreshedInstances,
    protectedPaths: () => protectedPaths,
    installationEnvironment: () => installationEnvironment,
  };
});

describe("provider installation routing", () => {
  it.effect.each([
    { setupMode: "managed", secretValue: "resolved-npm-token" },
    { setupMode: "managed", secretValue: undefined },
    { setupMode: "managed", secretValue: "" },
    { setupMode: "existing", secretValue: "resolved-npm-token" },
  ] as const)(
    "routes Claude installation in $setupMode mode with secret $secretValue",
    ({ setupMode, secretValue }) =>
      Effect.gen(function* () {
        const id = ProviderInstanceId.make("claude");
        const kind = ProviderDriverKind.make("claudeAgent");
        const harness = yield* makeHarness({
          instance: instance(kind, id),
          secretValue,
          settings: {
            providerInstances: {
              [id]: {
                driver: kind,
                config: { setupMode },
                environment: [
                  {
                    name: "NPM_TOKEN",
                    value: { provider: SecretProviderId.make("vault"), reference: "npm-token" },
                    sensitive: true,
                  },
                  {
                    name: "NPM_CONFIG_REGISTRY",
                    value: "https://registry.example.test",
                    sensitive: false,
                  },
                ],
              },
            },
          },
        });
        if (setupMode === "managed" && secretValue) {
          assert.strictEqual((yield* harness.router.start({ instanceId: id })).driver, kind);
          assert.deepEqual(harness.calls, ["claude-start"]);
          assert.strictEqual(harness.installationEnvironment()?.NPM_TOKEN, secretValue);
          assert.strictEqual(
            harness.installationEnvironment()?.NPM_CONFIG_REGISTRY,
            "https://registry.example.test",
          );
        } else {
          const error = yield* harness.router.start({ instanceId: id }).pipe(Effect.flip);
          assert.include(
            error.detail,
            setupMode === "existing" ? "Choose managed setup" : "NPM_TOKEN",
          );
          assert.deepEqual(harness.calls, []);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect.each([
    { phase: "succeeded", enabled: true, checkFails: false, expectedChecks: 1 },
    { phase: "succeeded", enabled: true, checkFails: true, expectedChecks: 1 },
    { phase: "succeeded", enabled: false, checkFails: false, expectedChecks: 0 },
    { phase: "cancelled", enabled: true, checkFails: false, expectedChecks: 0 },
    { phase: "failed", enabled: true, checkFails: false, expectedChecks: 0 },
  ] as const)(
    "checks account access once after installation is $phase, enabled=$enabled, checkFails=$checkFails",
    ({ phase, enabled, checkFails, expectedChecks }) =>
      Effect.gen(function* () {
        let checks = 0;
        const harness = yield* makeHarness({
          instance: Object.assign(instance(), {
            enabled,
            refreshModels: () =>
              Effect.sync(() => {
                checks++;
              }).pipe(
                Effect.andThen(
                  checkFails
                    ? Effect.fail(
                        new ProviderDriverError({
                          driver,
                          instanceId,
                          detail: "Sign in required.",
                        }),
                      )
                    : Effect.void,
                ),
              ),
          }),
        });
        yield* Effect.gen(function* () {
          const first = yield* harness.connect;
          const second = yield* harness.connect;
          yield* Effect.all([first.start({ instanceId }), second.start({ instanceId })], {
            concurrency: "unbounded",
          });
          yield* Deferred.await(harness.listening);
        }).pipe(Effect.scoped);
        assert.isFalse(yield* Deferred.isDone(harness.observed));
        assert.strictEqual(checks, 0);
        yield* SubscriptionRef.set(harness.installationState, {
          ...state,
          operationId: "install-1",
          phase,
          installedVersion: phase === "succeeded" ? "1.5.1" : null,
        });
        yield* Deferred.await(harness.observed);
        if (expectedChecks > 0) yield* Deferred.await(harness.refreshed);
        assert.strictEqual(checks, expectedChecks);
        assert.deepEqual(
          harness.calls,
          expectedChecks > 0 ? ["start", "start", "refresh"] : ["start", "start"],
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { source: "local", rebuilding: false },
    { source: "managed", rebuilding: false },
    { source: "local", rebuilding: true },
    { source: "managed", rebuilding: true },
    { source: "local", rebuilding: true, missingLocalRuntime: true },
  ] as const)(
    "projects the selected $source runtime for ChatGPT sign-in while rebuilding=$rebuilding",
    (testCase) =>
      Effect.gen(function* () {
        const { source, rebuilding } = testCase;
        const missingLocalRuntime = "missingLocalRuntime" in testCase;
        const kind = ProviderDriverKind.make("codex");
        const id = ProviderInstanceId.make("codex");
        const harness = yield* makeHarness({
          instance: instance(kind, id),
          rebuilding,
          missingLocalRuntime,
          settings: {
            providerInstances: {
              [id]: {
                driver: kind,
                config: {
                  connectionMode: "chatgpt",
                  runtimeSource: source,
                  binaryPath: "/custom/codex",
                  setupMode: "managed",
                },
              },
            },
          },
        });
        const observed = Array.from(
          yield* Stream.runCollect(harness.router.subscribe({ instanceId: id })),
        )[0];
        assert.equal(
          observed?.installedVersion,
          source === "local" && !missingLocalRuntime ? "0.169.0" : null,
        );
        assert.equal(
          observed?.executablePath,
          source === "local" && !missingLocalRuntime ? "/custom/codex" : null,
        );
        if (source === "local") {
          assert.include(observed, {
            source: "local",
            phase: "idle",
            operationId: null,
            downloadedBytes: 0,
            totalBytes: null,
            message: missingLocalRuntime ? "Local runtime not found" : null,
          });
          const start = yield* harness.router.start({ instanceId: id }).pipe(Effect.result);
          assert.equal(start._tag, "Failure");
        }
        assert.deepEqual(harness.calls, []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "updates one installation subscription when the runtime source and local path change",
    () =>
      Effect.gen(function* () {
        const kind = ProviderDriverKind.make("codex");
        const id = ProviderInstanceId.make("codex");
        const current = (
          source: "local" | "managed",
          binaryPath: string,
          searchPath = "/first",
        ): ServerSettingsValue => ({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [id]: {
              driver: kind,
              environment: [{ name: "PATH", value: searchPath, sensitive: false }],
              config: {
                connectionMode: "chatgpt",
                runtimeSource: source,
                setupMode: "managed",
                binaryPath,
              },
            },
          },
        });
        const settingsRef = yield* SubscriptionRef.make(current("local", "instance-codex"));
        const first = yield* Deferred.make<void>();
        const second = yield* Deferred.make<void>();
        const changedPath = yield* Deferred.make<void>();
        const harness = yield* makeHarness({ instance: instance(kind, id), settingsRef });
        const observed = yield* harness.router.subscribe({ instanceId: id }).pipe(
          Stream.tap((value) =>
            value.executablePath === "/first/instance-codex"
              ? Deferred.succeed(first, undefined)
              : value.executablePath === "/other/instance-codex"
                ? Deferred.succeed(changedPath, undefined)
                : Deferred.succeed(second, undefined),
          ),
          Stream.take(4),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(first);
        yield* SubscriptionRef.set(settingsRef, current("local", "instance-codex", "/other"));
        yield* Deferred.await(changedPath);
        yield* SubscriptionRef.set(settingsRef, current("managed", "/first/codex"));
        yield* Deferred.await(second);
        yield* SubscriptionRef.set(settingsRef, current("local", "/second/codex"));
        assert.deepEqual(
          Array.from(yield* Fiber.join(observed)).map((value) => value.executablePath),
          ["/first/instance-codex", "/other/instance-codex", null, "/second/codex"],
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects installation operations for a policy-disabled configured driver", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        rebuilding: true,
        policy: {
          organization: "Example",
          lockedSettings: [],
          limits: { providers: { allowedDrivers: [ProviderDriverKind.make("codex")] } },
        },
      });
      const requests = [
        harness.router.start({ instanceId }).pipe(Effect.asVoid),
        harness.router.remove({ instanceId }).pipe(Effect.asVoid),
        harness.router.cancel({ instanceId, operationId: "test-operation" }).pipe(Effect.asVoid),
        Stream.runCollect(harness.router.subscribe({ instanceId })).pipe(Effect.asVoid),
      ];
      for (const request of requests) {
        const error = yield* request.pipe(Effect.flip);
        assert.include(error.detail, "Example");
      }
      assert.deepEqual(harness.calls, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "checks every enabled instance on the managed runtime once, whichever instance started the install",
    () =>
      Effect.gen(function* () {
        const checked: string[] = [];
        const managed = (id: string, enabled: boolean) =>
          Object.assign(instance(driver, ProviderInstanceId.make(id)), {
            enabled,
            refreshModels: () =>
              Effect.sync(() => {
                checked.push(id);
              }),
          });
        const work = managed("antigravity_work", true);
        const personal = managed("antigravity_personal", true);
        const harness = yield* makeHarness({
          // The disabled default instance is listed first, as server.getConfig lists it.
          instance: managed("antigravity", false),
          others: [managed("antigravity_custom", true), work, personal],
          settings: {
            providerInstances: {
              [work.instanceId]: { driver, config: {} },
              [personal.instanceId]: { driver, config: {} },
              [ProviderInstanceId.make("antigravity_custom")]: {
                driver,
                config: { binaryPath: "/external/agy" },
              },
            },
          },
        });
        yield* Effect.gen(function* () {
          const first = yield* harness.connect;
          const second = yield* harness.connect;
          yield* Effect.all(
            [first.start({ instanceId }), second.start({ instanceId: personal.instanceId })],
            { concurrency: "unbounded" },
          );
          yield* Deferred.await(harness.listening);
        }).pipe(Effect.scoped);
        yield* SubscriptionRef.set(harness.installationState, {
          ...state,
          operationId: "install-1",
          phase: "succeeded",
          installedVersion: "1.5.8",
        });
        yield* Deferred.await(harness.observed);
        // Instances refresh in list order, so the last one's refresh ends a watch's pass.
        yield* Queue.take(harness.lastRefreshes);
        assert.deepEqual(checked, [work.instanceId, personal.instanceId]);
        // Let every other watch of this install finish its pass; none may refresh again.
        yield* Queue.takeN(harness.lastRefreshes, harness.watches() - 1);
        assert.deepEqual(checked, [work.instanceId, personal.instanceId]);
        assert.deepEqual(harness.refreshedInstances, [work.instanceId, personal.instanceId]);
        assert.strictEqual(harness.watches(), 1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("keeps external installs manual without hiding shared install status", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        settings: {
          providerInstances: {
            [ProviderInstanceId.make("antigravity")]: {
              driver: ProviderDriverKind.make("antigravity"),
              config: { binaryPath: "/external/agy" },
            },
          },
        },
      });
      const start = yield* Effect.flip(harness.router.start({ instanceId }));
      const remove = yield* Effect.flip(harness.router.remove({ instanceId }));
      assert.include(start.detail, "custom executable");
      assert.include(remove.detail, "custom executable");
      const observed = yield* Stream.runCollect(harness.router.subscribe({ instanceId }));
      assert.deepEqual(Array.from(observed), [state]);
      assert.deepEqual(harness.calls, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("protects another instance's binary found through its own PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-install-route-" });
      const binary = platform === "win32" ? "agy-test.exe" : "agy-test";
      const executable = path.join(directory, binary);
      yield* fs.writeFileString(executable, "test");
      yield* fs.chmod(executable, 0o755);
      const other = ProviderInstanceId.make("antigravity-work");
      const harness = yield* makeHarness({
        settings: {
          providerInstances: {
            [other]: {
              driver,
              config: { binaryPath: binary },
              environment: [{ name: "PATH", value: directory, sensitive: false }],
            },
          },
        },
      });
      yield* harness.router.remove({ instanceId });
      assert.include(harness.protectedPaths(), executable);
      assert.deepEqual(harness.calls, ["remove", "refresh"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

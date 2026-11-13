import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";

import * as Config from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as ClaudeInstallation from "./ClaudeInstallation.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import * as ProviderInstanceService from "./ProviderInstanceService.ts";

const codex = ProviderDriverKind.make("codex");
const id = ProviderInstanceId.make("codex_account");
const otherId = ProviderInstanceId.make("other_account");

const fixture = Effect.fn("ProviderInstanceService.test.fixture")(function* (input: {
  readonly instances: (root: string) => ProviderInstanceConfigMap;
  readonly failRuntimeRemoval?: boolean;
  readonly failSessionClose?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Config.ServerConfig;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-homes-" });
  const directory = path.join(config.stateDir, "providers", "codex", id);
  const runtime = path.join(config.baseDir, "tools", "codex");
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.makeDirectory(runtime, { recursive: true });
  yield* fs.writeFileString(path.join(directory, "auth.json"), "private");
  yield* fs.writeFileString(path.join(runtime, "codex"), "binary");
  let runtimeRemovalFails = input.failRuntimeRemoval ?? false;
  let reconciled = false;
  let sessionsClosed = false;
  const acpCalls: string[] = [];
  const dependencies = Layer.mergeAll(
    Layer.succeed(Config.ServerConfig, config),
    Layer.succeed(HostProcess.HomeDirectory, home),
    Settings.layerTest({ providerInstances: input.instances(directory) }),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      withInstanceClosed: (_instanceId, effect) =>
        input.failSessionClose
          ? Effect.fail(
              new ProviderSessionManager.ProviderSessionCloseError({
                providerSessionId: ProviderSessionId.make("fixture-session"),
                cause: "Fixture close failure",
              }),
            )
          : Effect.sync(() => {
              sessionsClosed = true;
            }).pipe(Effect.andThen(effect)),
    }),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: () => Effect.undefined,
      listInstances: Effect.succeed([]),
    }),
    Layer.mock(ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator)({
      reconcile: () =>
        Effect.sync(() => {
          reconciled = true;
        }),
    }),
    Layer.mock(CodexInstallation.CodexInstallation)({
      managedDirectory: runtime,
      remove: () =>
        Effect.gen(function* () {
          assert.isTrue(reconciled);
          assert.isTrue(sessionsClosed);
          if (runtimeRemovalFails)
            return yield* new CodexInstallation.CodexInstallationError({
              operation: "remove",
              detail: "Test cleanup failed.",
            });
          yield* fs.remove(runtime, { recursive: true, force: true }).pipe(
            Effect.mapError(
              (cause) =>
                new CodexInstallation.CodexInstallationError({
                  operation: "remove",
                  detail: "Test cleanup failed.",
                  cause,
                }),
            ),
          );
        }),
    }),
    Layer.mock(ClaudeInstallation.ClaudeInstallation)({ remove: () => Effect.void }),
    Layer.mock(AntigravityInstallation.AntigravityInstallation)({
      managedDirectory: path.join(config.baseDir, "tools", "antigravity"),
      remove: () => Effect.void,
    }),
    Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
      uninstallManagedBinary: ({ agentId }) =>
        Effect.sync(() => {
          acpCalls.push(agentId);
          return { agentId, removed: true };
        }),
    }),
  ).pipe(Layer.provideMerge(ServerSecretStore.layer));
  const context = yield* Layer.build(
    ProviderInstanceService.layer.pipe(Layer.provideMerge(dependencies)),
  );
  const service = yield* Effect.service(ProviderInstanceService.ProviderInstanceService).pipe(
    Effect.provide(context),
  );
  const settings = yield* Effect.service(Settings.ServerSettingsService).pipe(
    Effect.provide(context),
  );
  const store = yield* ProviderCredentialStore.make("codex-chatgpt", id).pipe(
    Effect.provide(context),
  );
  const registration = yield* ProviderCredentialStore.make("codex-chatgpt-registration", id).pipe(
    Effect.provide(context),
  );
  yield* store.set(new TextEncoder().encode("test-token"));
  yield* registration.set(new TextEncoder().encode("test-registration"));
  return {
    fs,
    path,
    directory,
    runtime,
    home,
    service,
    settings,
    store,
    registration,
    acpCalls,
    reconnect: Effect.service(ProviderInstanceService.ProviderInstanceService).pipe(
      Effect.provide(ProviderInstanceService.layer),
      Effect.provide(context),
    ),
    allowRuntimeCleanup: Effect.sync(() => {
      runtimeRemovalFails = false;
    }),
  };
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("provider removal", (it) => {
  const run = <A, E, R>(test: Effect.Effect<A, E, R>) =>
    test.pipe(Effect.provide(Config.layerTest(process.cwd(), { prefix: "t3-provider-removal-" })));

  it.effect("deletes unused managed homes, runtimes and both ChatGPT credential records", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({
          instances: () => ({ [id]: { driver: codex, config: { setupMode: "managed" } } }),
        });
        yield* f.service.update({ operation: "delete", instanceId: id });
        assert.isFalse(yield* f.fs.exists(f.directory));
        assert.isFalse(yield* f.fs.exists(f.runtime));
        assert.isTrue(Option.isNone(yield* f.store.get));
        assert.isTrue(Option.isNone(yield* f.registration.get));
        assert.isUndefined((yield* f.settings.getSettings).providerInstances[id]);
      }),
    ),
  );

  it.effect("keeps legacy remove requests non-destructive", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ instances: () => ({ [id]: { driver: codex } }) });
        const updated = yield* f.service.update({ operation: "remove", instanceId: id });
        assert.isUndefined(updated.providerInstances[id]);
        assert.isFalse(updated.removedProviderInstances?.includes(id) ?? false);
        assert.isTrue(yield* f.fs.exists(f.directory));
        assert.isTrue(yield* f.fs.exists(f.runtime));
        assert.isTrue(Option.isSome(yield* f.store.get));
      }),
    ),
  );

  it.effect("preserves the configuration and resources when active sessions cannot close", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({
          instances: () => ({ [id]: { driver: codex } }),
          failSessionClose: true,
        });
        const result = yield* f.service
          .update({ operation: "delete", instanceId: id })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.isDefined((yield* f.settings.getSettings).providerInstances[id]);
        assert.isTrue(yield* f.fs.exists(f.directory));
        assert.isTrue(yield* f.fs.exists(f.runtime));
        assert.isTrue(Option.isSome(yield* f.store.get));
      }),
    ),
  );

  it.effect("preserves another managed Codex instance's automatically selected shadow home", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({
          instances: (directory) => ({
            [id]: {
              driver: codex,
              config: { setupMode: "managed", homePath: `${directory}/../${otherId}/shadow` },
            },
            [otherId]: { driver: codex, config: { setupMode: "managed" } },
          }),
        });
        const shadow = f.path.join(f.path.dirname(f.directory), otherId, "shadow");
        yield* f.fs.makeDirectory(shadow, { recursive: true });
        yield* f.fs.writeFileString(f.path.join(shadow, "auth.json"), "other-provider");
        yield* f.service.update({ operation: "delete", instanceId: id });
        assert.equal(
          yield* f.fs.readFileString(f.path.join(shadow, "auth.json")),
          "other-provider",
        );
      }),
    ),
  );

  it.effect("cleans a deferred parent directory after its last nested consumer is deleted", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({
          instances: (directory) => ({
            [id]: { driver: codex, config: { setupMode: "managed" } },
            [otherId]: {
              driver: codex,
              config: { setupMode: "managed", homePath: `${directory}/nested` },
            },
          }),
        });
        yield* f.fs.makeDirectory(f.path.join(f.directory, "nested"), { recursive: true });
        yield* f.service.update({ operation: "delete", instanceId: id });
        assert.isTrue(yield* f.fs.exists(f.directory));
        const restarted = yield* f.reconnect;
        yield* restarted.update({ operation: "delete", instanceId: otherId });
        assert.isFalse(yield* f.fs.exists(f.directory));
      }),
    ),
  );

  it.effect(
    "retains a shared home and runtime for a disabled provider, then removes them with its last user",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture({
            instances: (directory) => ({
              [id]: { driver: codex, config: { setupMode: "managed" } },
              [otherId]: {
                driver: codex,
                enabled: false,
                config: { setupMode: "managed", homePath: directory },
              },
            }),
          });
          yield* f.service.update({ operation: "delete", instanceId: id });
          assert.isTrue(yield* f.fs.exists(f.directory));
          assert.isTrue(yield* f.fs.exists(f.runtime));
          yield* f.service.update({ operation: "delete", instanceId: otherId });
          assert.isFalse(yield* f.fs.exists(f.directory));
          assert.isFalse(yield* f.fs.exists(f.runtime));
        }),
      ),
  );

  it.effect(
    "preserves another driver's symlink to a managed executable and a missing child of its home",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture({
            instances: (directory) => ({
              [id]: { driver: codex, config: { setupMode: "managed" } },
              [otherId]: {
                driver: ProviderDriverKind.make("custom"),
                config: {
                  homePath: `${directory}/not-created`,
                },
              },
            }),
          });
          const alias = f.path.join(f.home, "custom-binary");
          yield* f.fs.symlink(f.path.join(f.runtime, "codex"), alias);
          yield* f.settings.updateProviderInstance({
            operation: "upsert",
            instanceId: otherId,
            instance: {
              driver: ProviderDriverKind.make("custom"),
              config: { binaryPath: alias, homePath: f.path.join(f.directory, "not-created") },
            },
          });
          yield* f.service.update({ operation: "delete", instanceId: id });
          assert.isTrue(yield* f.fs.exists(f.directory));
          assert.isTrue(yield* f.fs.exists(f.runtime));
          const restarted = yield* f.reconnect;
          yield* restarted.update({ operation: "delete", instanceId: otherId });
          assert.isFalse(yield* f.fs.exists(f.directory));
          assert.isFalse(yield* f.fs.exists(f.runtime));
        }),
      ),
  );

  it.effect("keeps a personal home outside T3's managed roots", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({
          instances: () => ({ [id]: { driver: codex, config: { homePath: "~/.codex" } } }),
        });
        const personal = f.path.join(f.home, ".codex");
        yield* f.fs.makeDirectory(personal);
        yield* f.fs.writeFileString(f.path.join(personal, "auth.json"), "personal");
        yield* f.service.update({ operation: "delete", instanceId: id });
        assert.equal(yield* f.fs.readFileString(f.path.join(personal, "auth.json")), "personal");
      }),
    ),
  );

  it.effect(
    "reports incomplete cleanup after removing settings and continues clearing owned credentials",
    () =>
      run(
        Effect.gen(function* () {
          const f = yield* fixture({
            instances: () => ({ [id]: { driver: codex } }),
            failRuntimeRemoval: true,
          });
          const failure = yield* f.service
            .update({ operation: "delete", instanceId: id })
            .pipe(Effect.flip);
          assert.equal(failure.operation, "remove-provider-resources");
          assert.isUndefined((yield* f.settings.getSettings).providerInstances[id]);
          assert.isFalse(yield* f.fs.exists(f.directory));
          assert.isTrue(yield* f.fs.exists(f.runtime));
          assert.isTrue(Option.isNone(yield* f.store.get));
          assert.isTrue(Option.isNone(yield* f.registration.get));
          yield* f.allowRuntimeCleanup;
          const restarted = yield* f.reconnect;
          yield* restarted.update({ operation: "delete", instanceId: id });
          assert.isFalse(yield* f.fs.exists(f.runtime));
        }),
      ),
  );

  it.effect("does not follow a managed directory's parent symlink into personal data", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({ instances: () => ({ [id]: { driver: codex } }) });
        const personal = f.path.join(f.home, "personal");
        const account = f.path.join(personal, id);
        yield* f.fs.makeDirectory(account, { recursive: true });
        yield* f.fs.writeFileString(f.path.join(account, "auth.json"), "personal");
        const parent = f.path.dirname(f.directory);
        yield* f.fs.remove(parent, { recursive: true });
        yield* f.fs.symlink(personal, parent);
        yield* f.service.update({ operation: "delete", instanceId: id });
        assert.equal(yield* f.fs.readFileString(f.path.join(account, "auth.json")), "personal");
      }),
    ),
  );

  it.effect("requests ACP cleanup on the server after removing its provider configuration", () =>
    run(
      Effect.gen(function* () {
        const f = yield* fixture({
          instances: () => ({
            [id]: {
              driver: ProviderDriverKind.make("acpRegistry"),
              config: { agentId: "agent-test" },
            },
          }),
        });
        yield* f.service.update({ operation: "delete", instanceId: id });
        assert.deepEqual(f.acpCalls, ["agent-test"]);
      }),
    ),
  );
});

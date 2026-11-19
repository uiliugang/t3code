import * as HostProcess from "@t3tools/shared/HostProcess";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { codexRuntimeSource } from "@t3tools/shared/codexByok";
import {
  AntigravitySettings,
  CodexSettings,
  ClaudeSettings,
  ProviderDriverKind,
  type ProviderInstallCancelInput,
  type ProviderInstallState,
  type ProviderInstanceId,
  type ProviderInstanceEnvironment,
  ProviderSetupError,
  type ProviderSetupInput,
} from "@t3tools/contracts";
import { configuredBinaryPaths } from "./configuredBinaryPaths.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as CodexInstallation from "./CodexInstallation.ts";
import * as ClaudeInstallation from "./ClaudeInstallation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { disallowedDriverReason } from "../policy/managedProviders.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";

const ANTIGRAVITY = ProviderDriverKind.make("antigravity");
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeAntigravitySettings = Schema.decodeUnknownEffect(AntigravitySettings);

export class ProviderInstallation extends Context.Service<
  ProviderInstallation,
  {
    readonly start: (
      input: ProviderSetupInput,
    ) => Effect.Effect<ProviderInstallState, ProviderSetupError>;
    readonly cancel: (
      input: ProviderInstallCancelInput,
    ) => Effect.Effect<ProviderInstallState, ProviderSetupError>;
    readonly subscribe: (
      input: ProviderSetupInput,
    ) => Stream.Stream<ProviderInstallState, ProviderSetupError>;
    readonly remove: (
      input: ProviderSetupInput,
    ) => Effect.Effect<ProviderInstallState, ProviderSetupError>;
  }
>()("t3/provider/providerInstallation") {}

const make = Effect.fn("makeProviderInstallation")(function* () {
  const antigravityInstallation = yield* AntigravityInstallation.AntigravityInstallation;
  const codexInstallation = yield* CodexInstallation.CodexInstallation;
  const claudeInstallation = yield* ClaudeInstallation.ClaudeInstallation;
  const secretResolver = yield* SecretResolver.SecretResolver;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const resolveInstallEnvironment = Effect.fn("ProviderInstallation.resolveInstallEnvironment")(
    function* (instanceId: ProviderInstanceId, environment: ProviderInstanceEnvironment = []) {
      const references = environment.flatMap((variable) =>
        typeof variable.value === "string" ? [] : [variable.value],
      );
      const values = references.length > 0 ? yield* secretResolver.read(references) : [];
      let index = 0;
      const resolved = yield* Effect.forEach(
        environment,
        Effect.fnUntraced(function* (variable) {
          if (typeof variable.value === "string") return { ...variable, value: variable.value };
          const value = values[index++];
          if (value === undefined || value.trim() === "") {
            return yield* new ProviderSetupError({
              instanceId,
              operation: "install",
              detail: `Could not read ${variable.name} from its secret provider. Unlock it, then retry installation.`,
            });
          }
          return { ...variable, value };
        }),
      );
      return yield* mergeProviderInstanceEnvironment(resolved);
    },
  );
  // A start during a running install joins it, so one operation is checked once whichever instance asked.
  let accountCheckOperation: string | undefined;

  const readEntries = Effect.fn("ProviderInstallation.readEntries")(function* (
    instanceId: ProviderInstanceId,
    operation: string,
  ) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId,
            operation,
            detail: "Could not read provider installation settings.",
          }),
      ),
    );
    return deriveProviderInstanceConfigMap(current);
  });

  const requireInstance = Effect.fn("ProviderInstallation.requireInstance")(function* (
    instanceId: ProviderInstanceId,
    operation: string,
    managedOnly = false,
  ) {
    const entries = yield* readEntries(instanceId, operation);
    // Settings remain available while a runtime switch rebuilds the live instance.
    const driver = entries[instanceId]?.driver;
    const isCodex = driver === ProviderDriverKind.make("codex");
    const isClaude = driver === ProviderDriverKind.make("claudeAgent");
    if (driver === undefined || (driver !== ANTIGRAVITY && !isCodex && !isClaude)) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: "Managed installation is not available for this provider instance.",
      });
    }
    const blocked = disallowedDriverReason(settings.managedPolicy, driver);
    if (blocked) {
      return yield* new ProviderSetupError({ instanceId, operation, detail: blocked });
    }
    const installation = isClaude
      ? {
          ...claudeInstallation,
          start: resolveInstallEnvironment(instanceId, entries[instanceId]?.environment).pipe(
            Effect.flatMap(claudeInstallation.start),
          ),
        }
      : isCodex
        ? {
            ...codexInstallation,
            start:
              codexRuntimeSource(entries[instanceId]?.config) === "managed"
                ? codexInstallation.startManaged
                : codexInstallation.start,
          }
        : antigravityInstallation;
    const invalidConfig = () =>
      new ProviderSetupError({
        instanceId,
        operation,
        detail: "The provider instance configuration is invalid.",
      });
    const config = isClaude
      ? yield* decodeClaudeSettings(entries[instanceId]?.config ?? {}).pipe(
          Effect.mapError(invalidConfig),
        )
      : isCodex
        ? yield* decodeCodexSettings(entries[instanceId]?.config ?? {}).pipe(
            Effect.mapError(invalidConfig),
          )
        : yield* decodeAntigravitySettings(entries[instanceId]?.config ?? {}).pipe(
            Effect.mapError(invalidConfig),
          );
    if (
      (isCodex && codexRuntimeSource(config) === "local" && operation !== "observe-install") ||
      (isClaude && (!("setupMode" in config) || config.setupMode !== "managed"))
    ) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: `Choose managed setup to install ${isClaude ? "Claude" : "Codex"} in T3 Code.`,
      });
    }
    if (
      managedOnly &&
      !isClaude &&
      config.binaryPath &&
      (!isCodex || (codexRuntimeSource(config) !== "managed" && config.binaryPath !== "codex"))
    ) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail:
          "This instance uses a custom executable. Clear its binary path to manage installation in T3 Code.",
      });
    }
    if (isCodex && operation === "observe-install") {
      const source = codexRuntimeSource(config);
      const instanceEnvironment = yield* mergeProviderInstanceEnvironment(
        entries[instanceId]?.environment,
      );
      const binaryPath = expandHomePath(
        config.binaryPath ?? "codex",
        yield* HostProcess.HomeDirectory,
      );
      const projectState = (shared: ProviderInstallState) => {
        const state: ProviderInstallState =
          source === "local"
            ? {
                ...shared,
                source,
                phase: "idle",
                operationId: null,
                downloadedBytes: 0,
                totalBytes: null,
                message: null,
              }
            : shared;
        return source !== "local" &&
          ["downloading", "extracting", "verifying"].includes(state.phase)
          ? Effect.succeed(state)
          : codexInstallation.resolve(source, binaryPath, instanceEnvironment).pipe(
              Effect.match({
                onFailure: (error): ProviderInstallState => ({
                  ...state,
                  installedVersion: null,
                  executablePath: null,
                  canRemove: false,
                  message: error.detail,
                }),
                onSuccess: (executable): ProviderInstallState => ({
                  ...state,
                  source: executable.source,
                  installedVersion: executable.version,
                  executablePath: executable.executablePath,
                  canRemove: executable.source === "managed" && state.canRemove,
                }),
              }),
            );
      };
      return {
        installation: {
          ...installation,
          changes: (source === "local"
            ? Stream.fromEffect(codexInstallation.state)
            : codexInstallation.changes
          ).pipe(Stream.mapEffect(projectState)),
        },
        driver,
      };
    }
    return { installation, driver };
  });

  const failure =
    (instanceId: ProviderInstanceId) =>
    (
      error:
        | AntigravityInstallation.AntigravityInstallationError
        | CodexInstallation.CodexInstallationError
        | ClaudeInstallation.ClaudeInstallationError
        | ProviderSetupError,
    ) =>
      new ProviderSetupError({ instanceId, operation: error.operation, detail: error.detail });

  // Every instance without a custom executable runs the one managed runtime, so an install
  // replaces the runtime behind all of their model lists, not only the instance that asked.
  const checkManagedRuntimeInstances = Effect.fn(
    "ProviderInstallation.checkManagedRuntimeInstances",
  )(function* (instanceId: ProviderInstanceId) {
    const entries = yield* readEntries(instanceId, "install");
    for (const instance of yield* instances.listInstances) {
      if (instance.driverKind !== ANTIGRAVITY || !instance.enabled || !instance.refreshModels) {
        continue;
      }
      const config = yield* decodeAntigravitySettings(
        entries[instance.instanceId]?.config ?? {},
      ).pipe(Effect.option);
      if (Option.isNone(config) || config.value.binaryPath) continue;
      yield* instance.refreshModels().pipe(Effect.ignore({ log: true }));
      yield* providers.refreshInstance(instance.instanceId);
    }
  });

  const start = Effect.fn("ProviderInstallation.start")(function* (input: ProviderSetupInput) {
    const { installation, driver } = yield* requireInstance(input.instanceId, "install", true);
    const started = yield* installation.start.pipe(Effect.mapError(failure(input.instanceId)));
    if (
      driver === ANTIGRAVITY &&
      started.operationId !== null &&
      accountCheckOperation !== started.operationId
    ) {
      accountCheckOperation = started.operationId;
      // Installation outlives the request and may finish while every client is disconnected.
      yield* installation.changes.pipe(
        Stream.filter(
          (state) =>
            state.operationId !== started.operationId ||
            state.phase === "succeeded" ||
            state.phase === "failed" ||
            state.phase === "cancelled",
        ),
        Stream.runHead,
        Effect.flatMap((result) =>
          Option.isSome(result) &&
          result.value.operationId === started.operationId &&
          result.value.phase === "succeeded"
            ? checkManagedRuntimeInstances(input.instanceId)
            : Effect.void,
        ),
        Effect.ignore({ log: true }),
        Effect.forkIn(scope),
      );
    }
    return started;
  });

  const cancel = Effect.fn("ProviderInstallation.cancel")(function* (
    input: ProviderInstallCancelInput,
  ) {
    const { installation } = yield* requireInstance(input.instanceId, "cancel-install");
    return yield* installation
      .cancel(input.operationId)
      .pipe(Effect.mapError(failure(input.instanceId)));
  });

  // Watching an installation is when its owner can act on an update, so the
  // lookup runs then, in the background, unless update checks are off.
  const subscribeCurrent = (input: ProviderSetupInput) =>
    Stream.unwrap(
      requireInstance(input.instanceId, "observe-install").pipe(
        Effect.tap(({ installation }) =>
          settings.getSettings.pipe(
            Effect.flatMap((current) =>
              current.enableProviderUpdateChecks && "checkForUpdate" in installation
                ? Effect.forkDetach(installation.checkForUpdate)
                : Effect.void,
            ),
            Effect.ignore,
          ),
        ),
        Effect.map(({ installation }) => installation.changes),
      ),
    );

  const subscribe = (input: ProviderSetupInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const changes = yield* settings.subscribeChanges;
        return Stream.concat(
          Stream.fromEffect(
            settings.getSettings.pipe(
              Effect.mapError(
                () =>
                  new ProviderSetupError({
                    instanceId: input.instanceId,
                    operation: "observe-install",
                    detail: "Could not read provider installation settings.",
                  }),
              ),
            ),
          ),
          changes,
        ).pipe(
          Stream.map((current) => {
            const entry = deriveProviderInstanceConfigMap(current)[input.instanceId];
            const config = entry?.config;
            const read = (key: string) =>
              config && typeof config === "object" ? Reflect.get(config, key) : undefined;
            return [
              entry?.driver,
              entry?.driver === "codex" ? codexRuntimeSource(config) : read("setupMode"),
              read("binaryPath"),
              ...(entry?.driver === "codex"
                ? (entry.environment
                    ?.filter((variable) => variable.name.toUpperCase() === "PATH")
                    .map((variable) => variable.value) ?? [])
                : []),
            ];
          }),
          Stream.changesWith(
            (before, after) =>
              before.length === after.length &&
              before.every((value, index) => value === after[index]),
          ),
          Stream.switchMap(() => subscribeCurrent(input)),
        );
      }),
    );

  const remove = Effect.fn("ProviderInstallation.remove")(function* (input: ProviderSetupInput) {
    const { installation, driver } = yield* requireInstance(
      input.instanceId,
      "remove-install",
      true,
    );
    const entries = yield* readEntries(input.instanceId, "remove-install");
    const protectedPaths = yield* configuredBinaryPaths(entries).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    yield* installation.remove(protectedPaths).pipe(Effect.mapError(failure(input.instanceId)));
    const allInstances = yield* instances.listInstances;
    yield* Effect.forEach(
      allInstances.filter((instance) => instance.driverKind === driver),
      (instance) => providers.refreshInstance(instance.instanceId),
      { discard: true },
    );
    return yield* installation.state;
  });

  return { start, cancel, subscribe, remove };
});

export const layer = Layer.effect(ProviderInstallation, make());

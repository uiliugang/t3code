import {
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ProviderInstanceMutation,
  type ServerSettingsPatch,
  type ServerSettings,
  ServerSettingsError,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import type * as PlatformError from "effect/PlatformError";
import * as Digest from "effect/crypto/Digest";

import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as ClaudeInstallation from "./ClaudeInstallation.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";

const ManagedResource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("directory"), path: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("installation"),
    driver: Schema.Literals(["codex", "claudeAgent", "antigravity"]),
  }),
  Schema.Struct({ kind: Schema.Literal("acp"), agentId: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("credential"),
    instanceId: ProviderInstanceId,
    key: Schema.String,
  }),
]);
type ManagedResource = typeof ManagedResource.Type;
const Journal = Schema.fromJsonString(Schema.Array(ManagedResource));
const decodeJournal = Schema.decodeUnknownEffect(Journal);
const encodeJournal = Schema.encodeEffect(Journal);
const isSettingsError = Schema.is(ServerSettingsError);

function resourceKey(resource: ManagedResource): string {
  switch (resource.kind) {
    case "directory":
      return "directory:" + resource.path;
    case "installation":
      return "installation:" + resource.driver;
    case "acp":
      return "acp:" + resource.agentId;
    case "credential":
      return "credential:" + resource.instanceId + ":" + resource.key;
  }
}

function configString(instance: ProviderInstanceConfig, key: string): string {
  if (instance.config === null || typeof instance.config !== "object") return "";
  const value: unknown = Reflect.get(instance.config, key);
  return typeof value === "string" ? value.trim() : "";
}

export class ProviderInstanceService extends Context.Service<
  ProviderInstanceService,
  {
    readonly update: (
      mutation: ProviderInstanceMutation,
      patch?: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;
  }
>()("t3/provider/ProviderInstanceService") {}

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const mutator = yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const codex = yield* CodexInstallation.CodexInstallation;
  const claude = yield* ClaudeInstallation.ClaudeInstallation;
  const antigravity = yield* AntigravityInstallation.AntigravityInstallation;
  const acp = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const digest = yield* Digest.Digest;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const claudePaths = yield* ClaudeInstallation.claudeManagedPaths();
  const installations = {
    codex: { directory: codex.managedDirectory, service: codex },
    claudeAgent: { directory: claudePaths.directory, service: claude },
    antigravity: { directory: antigravity.managedDirectory, service: antigravity },
  };
  const gate = yield* Semaphore.make(1);
  const journalPath = path.join(config.stateDir, "provider-resource-cleanup.json");
  const absolute = (value: string) => path.resolve(expandHomePath(value, home));
  const contains = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
    );
  };
  const canonical = Effect.fn("ProviderInstanceService.canonical")(function* (
    value: string,
  ): Effect.fn.Return<string, PlatformError.PlatformError> {
    return yield* fs.realPath(value).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? path.dirname(value) === value
              ? Effect.succeed(value)
              : canonical(path.dirname(value)).pipe(
                  Effect.map((parent) => path.join(parent, path.basename(value))),
                )
            : Effect.fail(error),
      }),
    );
  });
  const ownedRoots = Effect.gen(function* () {
    const state = yield* canonical(config.stateDir);
    // User-level account homes may be shared by environments whose references are not visible here.
    return [path.join(state, "providers"), path.join(state, "provider-auth")];
  });
  const directoriesFor = Effect.fn("ProviderInstanceService.directoriesFor")(function* (
    instanceId: ProviderInstanceId,
    entry: ProviderInstanceConfig,
  ) {
    const environment = yield* mergeProviderInstanceEnvironment(entry.environment);
    const roots = yield* ownedRoots;
    const candidates = [
      path.join(config.stateDir, "providers", entry.driver, instanceId),
      path.join(config.stateDir, "provider-auth", instanceId),
      configString(entry, "homePath"),
      configString(entry, "shadowHomePath"),
      entry.driver === "codex"
        ? environment.CODEX_HOME
        : entry.driver === "claudeAgent"
          ? environment.CLAUDE_CONFIG_DIR
          : undefined,
    ];
    const directories = new Set<string>();
    for (const value of candidates) {
      if (!value) continue;
      const directory = yield* canonical(absolute(value));
      if (roots.some((root) => directory !== root && contains(root, directory)))
        directories.add(directory);
    }
    return [...directories];
  });
  const readJournal = Effect.fn("ProviderInstanceService.readJournal")(function* () {
    const contents = yield* fs.readFileString(journalPath).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("[]") : Effect.fail(error),
      }),
    );
    return yield* decodeJournal(contents);
  });
  const saveJournal = Effect.fn("ProviderInstanceService.saveJournal")(function* (
    resources: ReadonlyArray<ManagedResource>,
  ) {
    if (resources.length === 0) return yield* fs.remove(journalPath, { force: true });
    const contents = yield* encodeJournal(resources);
    yield* writeFileStringAtomically({ filePath: journalPath, contents });
  });

  const remove = Effect.fn("ProviderInstanceService.delete")(function* (
    instanceId: ProviderInstanceId,
    patch: ServerSettingsPatch,
  ) {
    const failure = (cause: unknown) =>
      new ServerSettingsError({
        operation: "remove-provider-resources",
        settingsPath: config.settingsPath,
        providerInstanceId: instanceId,
        cause,
      });
    const before = deriveProviderInstanceConfigMap(yield* settings.getSettings)[instanceId];
    const resources = new Map(
      (yield* readJournal().pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({ operation: "read-file", settingsPath: journalPath, cause }),
        ),
      )).map((resource) => [resourceKey(resource), resource]),
    );
    const enqueue = (resource: ManagedResource) => resources.set(resourceKey(resource), resource);
    if (before) {
      for (const directory of yield* directoriesFor(instanceId, before).pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({
              operation: "check-exists",
              settingsPath: config.settingsPath,
              cause,
            }),
        ),
      )) {
        enqueue({ kind: "directory", path: directory });
      }
      const installationDriver =
        before.driver === "codex"
          ? "codex"
          : before.driver === "claudeAgent"
            ? "claudeAgent"
            : before.driver === "antigravity"
              ? "antigravity"
              : undefined;
      if (installationDriver) enqueue({ kind: "installation", driver: installationDriver });
      if (before.driver === "acpRegistry" && configString(before, "source") !== "local") {
        const agentId = configString(before, "agentId");
        if (agentId) enqueue({ kind: "acp", agentId });
      }
      const binding = (yield* registry.getInstance(instanceId))?.auth?.credentialBinding;
      if (binding?.owner === "t3") enqueue({ kind: "credential", instanceId, key: binding.key });
      const namespaces =
        before.driver === "codex"
          ? ["codex-chatgpt", "codex-chatgpt-registration"]
          : before.driver === "cursor"
            ? ["cursor"]
            : [];
      for (const namespace of namespaces) {
        const store = yield* ProviderCredentialStore.make(namespace, instanceId).pipe(
          Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
          Effect.provideService(Digest.Digest, digest),
        );
        enqueue({ kind: "credential", instanceId, key: store.binding.key });
      }
    }
    yield* saveJournal([...resources.values()]).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            operation: "write-file",
            settingsPath: journalPath,
            cause,
          }),
      ),
    );
    const updated = yield* settings.updateProviderInstance(
      { operation: "delete", instanceId },
      patch,
    );
    yield* mutator.reconcile(deriveProviderInstanceConfigMap(yield* settings.getSettings));
    const pending: ManagedResource[] = [];
    const errors: ServerSettingsError[] = [];

    yield* settings
      .withSettingsSnapshot((current) =>
        Effect.gen(function* () {
          const instances = deriveProviderInstanceConfigMap(current);
          const entries = Object.values(instances);
          const references: string[] = [];
          const pathVariables = new Set([
            "HOME",
            "USERPROFILE",
            "PATH",
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "CURSOR_CONFIG_DIR",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_STATE_HOME",
            "XDG_CACHE_HOME",
          ]);
          const unresolvedPaths = entries.some((entry) =>
            entry.environment?.some(
              (variable) => pathVariables.has(variable.name) && typeof variable.value !== "string",
            ),
          );
          for (const [rawId, entry] of Object.entries(instances)) {
            references.push(...(yield* directoriesFor(ProviderInstanceId.make(rawId), entry)));
            for (const key of ["binaryPath", "commandPath", "homePath", "shadowHomePath"]) {
              const value = configString(entry, key);
              if (value) references.push(absolute(value));
            }
            const environment = yield* mergeProviderInstanceEnvironment(entry.environment);
            for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "CURSOR_CONFIG_DIR"]) {
              if (environment[name]) references.push(absolute(environment[name]));
            }
            for (const variable of entry.environment ?? []) {
              const value = environment[variable.name];
              if (pathVariables.has(variable.name) && variable.name !== "PATH" && value)
                references.push(absolute(value));
            }
            if (entry.driver === "codex")
              references.push(
                absolute(
                  configString(entry, "homePath") ||
                    environment.CODEX_HOME ||
                    path.join(home, ".codex"),
                ),
              );
            if (entry.driver === "claudeAgent")
              references.push(
                absolute(
                  configString(entry, "homePath") ||
                    environment.CLAUDE_CONFIG_DIR ||
                    path.join(home, ".claude"),
                ),
              );
            const binary =
              configString(entry, "binaryPath") ||
              configString(entry, "commandPath") ||
              (entry.driver === "codex" ? "codex" : entry.driver === "claudeAgent" ? "claude" : "");
            if (binary) {
              const resolved = yield* resolveCommandPath(expandHomePath(binary, home), {
                env: environment,
              });
              if (resolved) references.push(resolved);
            }
          }
          const realReferences = yield* Effect.forEach(references, canonical);
          const shared = (directory: string) =>
            unresolvedPaths ||
            realReferences.some(
              (reference) => contains(directory, reference) || contains(reference, directory),
            );
          const roots = yield* ownedRoots;
          const realBase = yield* canonical(config.baseDir);
          const remaining = yield* registry.listInstances;
          for (const resource of resources.values()) {
            const result = yield* Effect.gen(function* () {
              switch (resource.kind) {
                case "directory": {
                  const directory = yield* canonical(resource.path);
                  if (!roots.some((root) => directory !== root && contains(root, directory)))
                    return true;
                  if (shared(directory)) return false;
                  yield* fs.remove(directory, { recursive: true, force: true });
                  return true;
                }
                case "installation": {
                  const installation = installations[resource.driver];
                  const directory = yield* canonical(installation.directory);
                  if (
                    directory !==
                    path.join(realBase, path.relative(config.baseDir, installation.directory))
                  )
                    return false;
                  if (
                    shared(directory) ||
                    entries.some(
                      (entry) =>
                        entry.driver === resource.driver &&
                        (configString(entry, "setupMode") === "managed" ||
                          (entry.driver === "antigravity" && !configString(entry, "binaryPath"))),
                    )
                  )
                    return false;
                  yield* installation.service.remove(references);
                  return true;
                }
                case "credential": {
                  if (
                    instances[resource.instanceId] ||
                    remaining.some(
                      (entry) =>
                        entry.auth?.credentialBinding?.owner === "t3" &&
                        entry.auth.credentialBinding.key === resource.key,
                    )
                  )
                    return false;
                  yield* secrets.remove(resource.key);
                  return true;
                }
                case "acp":
                  return false;
              }
            }).pipe(Effect.mapError(failure), Effect.result);
            if (result._tag === "Failure") {
              errors.push(result.failure);
              pending.push(resource);
            } else if (!result.success) pending.push(resource);
          }
        }),
      )
      .pipe(Effect.mapError((cause) => (isSettingsError(cause) ? cause : failure(cause))));
    const retained: ManagedResource[] = [];
    for (const resource of pending) {
      if (resource.kind !== "acp") {
        retained.push(resource);
        continue;
      }
      const result = yield* acp
        .uninstallManagedBinary({ agentId: resource.agentId, includePackages: true })
        .pipe(Effect.mapError(failure), Effect.result);
      if (result._tag === "Failure") {
        errors.push(result.failure);
        retained.push(resource);
      } else if (
        !result.success.removed &&
        (yield* fs
          .exists(path.join(config.baseDir, "tools", resource.agentId))
          .pipe(Effect.mapError(failure)))
      ) {
        retained.push(resource);
      }
    }
    yield* saveJournal(retained).pipe(Effect.mapError(failure));
    const error = errors[0];
    if (error) return yield* error;
    return updated;
  });

  const update = Effect.fn("ProviderInstanceService.update")(function* (
    mutation: ProviderInstanceMutation,
    patch: ServerSettingsPatch = {},
  ) {
    if (mutation.operation !== "delete")
      return yield* settings.updateProviderInstance(mutation, patch);
    yield* settings.validateProviderInstanceMutation(mutation, patch);
    return yield* sessions
      .withInstanceClosed(mutation.instanceId, remove(mutation.instanceId, patch))
      .pipe(
        Effect.mapError((cause) =>
          isSettingsError(cause)
            ? cause
            : new ServerSettingsError({
                operation: "stop-provider-sessions",
                settingsPath: config.settingsPath,
                providerInstanceId: mutation.instanceId,
                cause,
              }),
        ),
      );
  });
  return {
    update: (mutation: ProviderInstanceMutation, patch?: ServerSettingsPatch) =>
      gate.withPermits(1)(
        update(mutation, patch).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.uninterruptible,
        ),
      ),
  };
});

export const layer = Layer.effect(ProviderInstanceService, make);

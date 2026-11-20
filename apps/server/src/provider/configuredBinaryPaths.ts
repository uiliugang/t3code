import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  type ServerSettings,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { codexRuntimeSource } from "@t3tools/shared/codexByok";
import { resolveCommandPath, resolveCommandPaths } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerSettingsService } from "../serverSettings.ts";
import { providerConnectionConfigurations } from "./providerConnectionProfiles.ts";

const hasBinaryPath = Schema.is(Schema.Struct({ binaryPath: Schema.String }));
const hasCommandPath = Schema.is(Schema.Struct({ commandPath: Schema.String }));
const codexDriver = ProviderDriverKind.make("codex");
const defaultCodexInstance = defaultInstanceIdForDriver(codexDriver);

class UnresolvedBinaryPathEnvironment extends Schema.TaggedError<
  UnresolvedBinaryPathEnvironment,
  { readonly brand: unique symbol }
>()("UnresolvedBinaryPathEnvironment", { variable: Schema.String }) {}

function instancesForCleanup(settings: ServerSettings): ProviderInstanceConfigMap {
  if (
    settings.providerInstances[defaultCodexInstance] !== undefined ||
    settings.removedProviderInstances?.includes(defaultCodexInstance)
  ) {
    return settings.providerInstances;
  }
  return { ...settings.providerInstances, [defaultCodexInstance]: { driver: codexDriver } };
}

export const configuredBinaryPaths = Effect.fn("ProviderInstallation.configuredBinaryPaths")(
  function* (entries: ProviderInstanceConfigMap) {
    const paths = new Set<string>();
    const home = yield* HostProcess.HomeDirectory;
    const hostEnvironment = yield* HostProcess.Environment;
    const windows = (yield* HostProcess.Platform) === "win32";
    for (const { driver, config, environment } of Object.values(entries).flatMap(
      providerConnectionConfigurations,
    )) {
      const configuredPaths = [
        hasBinaryPath(config) ? config.binaryPath.trim() : "",
        hasCommandPath(config) ? config.commandPath.trim() : "",
      ].filter((value) => value.length > 0);
      const candidates =
        configuredPaths.length > 0
          ? configuredPaths
          : driver === "codex" && codexRuntimeSource(config) === "local"
            ? ["codex"]
            : [];
      for (const rawBinary of candidates) {
        const binary = expandHomePath(rawBinary, home);
        if (!binary) continue;
        const searchPath = !binary.includes("/") && !binary.includes("\\");
        const unresolved = environment?.find(({ name, value }) => {
          const key = windows ? name.toUpperCase() : name;
          return (
            typeof value !== "string" &&
            ((searchPath && key === "PATH") || (windows && key === "PATHEXT"))
          );
        });
        if (unresolved) {
          return yield* new UnresolvedBinaryPathEnvironment({ variable: unresolved.name });
        }
        paths.add(binary);
        const env = yield* mergeProviderInstanceEnvironment(environment, hostEnvironment);
        if (searchPath) {
          const matches = yield* resolveCommandPaths(binary, {
            env,
            until: () => driver !== "antigravity",
          });
          for (const match of matches) paths.add(match);
        } else {
          const resolved = yield* resolveCommandPath(binary, { env });
          if (resolved !== null) paths.add(resolved);
        }
      }
    }
    return [...paths];
  },
);

export type WithProtectedBinaryPaths = <A, E, R>(
  use: (paths: ReadonlyArray<string>, settings: ServerSettings) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | ServerSettingsError | UnresolvedBinaryPathEnvironment, R>;

export const makeProtectedBinaryPathSnapshot = Effect.fn(
  "ProviderInstallation.makeProtectedBinaryPathSnapshot",
)(function* () {
  const settings = yield* ServerSettingsService;
  const services =
    yield* Effect.context<Effect.Services<ReturnType<typeof configuredBinaryPaths>>>();
  const withProtectedBinaryPaths: WithProtectedBinaryPaths = (use) =>
    settings.withSettingsSnapshot(
      (effective, stored) =>
        Effect.gen(function* () {
          const activePaths = yield* configuredBinaryPaths(instancesForCleanup(effective));
          const storedPaths =
            stored === undefined ? [] : yield* configuredBinaryPaths(instancesForCleanup(stored));
          return yield* use([...new Set([...activePaths, ...storedPaths])], effective);
        }).pipe(Effect.provide(services)),
      { tryTrusted: true },
    );
  return withProtectedBinaryPaths;
});

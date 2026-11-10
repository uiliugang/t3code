import { ProviderDriverKind, type ProviderInstallState } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { parseGenericCliVersion } from "@t3tools/provider-core/server/snapshotProbe";
import * as ModelManifest from "./ModelManifest.ts";
import { resolveProviderCompatibility } from "./providerCompatibility.ts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";

const PACKAGE = "@anthropic-ai/claude-code";
const PackageRecord = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));
const LatestVersion = Schema.fromJsonString(
  Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)),
);

export const claudeManagedPaths = Effect.fn("ClaudeInstallation.paths")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const directory = path.join(config.baseDir, "tools", "claude");
  return {
    directory,
    binaryPath: path.join(
      directory,
      ...(platform === "win32" ? ["claude.cmd"] : ["bin", "claude"]),
    ),
    packagePath: path.join(
      directory,
      ...(platform === "win32" ? [] : ["lib"]),
      "node_modules",
      PACKAGE,
      "package.json",
    ),
  };
});

export class ClaudeInstallationError extends Schema.TaggedError<ClaudeInstallationError>()(
  "ClaudeInstallationError",
  { operation: Schema.String, detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
const isInstallationError = Schema.is(ClaudeInstallationError);

export class ClaudeInstallation extends Context.Service<
  ClaudeInstallation,
  {
    readonly start: (
      env: NodeJS.ProcessEnv,
    ) => Effect.Effect<ProviderInstallState, ClaudeInstallationError>;
    readonly cancel: (
      operationId: string,
    ) => Effect.Effect<ProviderInstallState, ClaudeInstallationError>;
    readonly remove: (
      protectedPaths?: ReadonlyArray<string>,
    ) => Effect.Effect<void, ClaudeInstallationError>;
    readonly state: Effect.Effect<ProviderInstallState>;
    readonly changes: Stream.Stream<ProviderInstallState>;
  }
>()("t3/provider/ClaudeInstallation") {}

const make = Effect.fn("ClaudeInstallation.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const manifest = yield* ModelManifest.ModelManifest;
  const random = yield* SecureRandom.SecureRandom;
  const scope = yield* Effect.scope;
  const paths = yield* claudeManagedPaths();
  const gate = yield* Semaphore.make(1);
  let running: { operationId: string; fiber: Fiber.Fiber<void> } | undefined;
  const readVersion = fs.readFileString(paths.packagePath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PackageRecord)),
    Effect.map((record) => record.version),
    Effect.orElseSucceed(() => null),
  );
  const installedVersion = yield* readVersion;
  const state = yield* SubscriptionRef.make<ProviderInstallState>({
    driver: ProviderDriverKind.make("claudeAgent"),
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: null,
    version: null,
    installedVersion,
    executablePath: installedVersion ? paths.binaryPath : null,
    source: "managed",
    canRemove: yield* fs.exists(paths.directory),
    message: null,
  });
  const fail = (operation: string, detail: string, cause?: unknown) =>
    new ClaudeInstallationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });
  const run = Effect.fn("ClaudeInstallation.run")(function* (
    command: string,
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv,
  ) {
    const resolved = yield* resolveSpawnCommand(command, args, { env, extendEnv: true });
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        shell: resolved.shell,
        env,
        extendEnv: true,
      }),
    );
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
    const [stdout, , code] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: 10_000 }),
        child.stderr.pipe(Stream.runDrain),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (code !== 0)
      return yield* fail("install", "Claude installation failed. Check npm access and retry.");
    return stdout.text;
  }, Effect.scoped);
  const start = Effect.fn("ClaudeInstallation.start")(function* (env: NodeJS.ProcessEnv) {
    return yield* gate.withPermit(
      Effect.gen(function* () {
        if (running) return yield* SubscriptionRef.get(state);
        const operationId = yield* random.uuidV4();
        yield* SubscriptionRef.update(state, (current): ProviderInstallState => ({
          ...current,
          operationId,
          phase: "downloading",
          message: "Installing Claude with npm.",
          canRemove: true,
        }));
        const install = Effect.gen(function* () {
          const latest = yield* run(
            "npm",
            ["view", `${PACKAGE}@latest`, "version", "--json"],
            env,
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(LatestVersion)));
          const compatibility =
            resolveProviderCompatibility(
              (yield* manifest.current).compatibility,
              ProviderDriverKind.make("claudeAgent"),
              latest,
            ) ??
            resolveProviderCompatibility(
              ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
              ProviderDriverKind.make("claudeAgent"),
              latest,
            );
          if (compatibility?.status === "broken" || compatibility?.status === "unsupported")
            return yield* fail(
              "install",
              "The latest Claude version is incompatible with this T3 Code release.",
            );
          yield* fs.makeDirectory(paths.directory, { recursive: true });
          yield* run(
            "npm",
            [
              "install",
              "-g",
              "--prefix",
              paths.directory,
              `--allow-scripts=${PACKAGE}`,
              `${PACKAGE}@${latest}`,
            ],
            env,
          );
          yield* SubscriptionRef.update(state, (current): ProviderInstallState => ({
            ...current,
            phase: "verifying",
          }));
          const version = yield* readVersion;
          if (version !== latest)
            return yield* fail(
              "verify",
              "npm completed but the Claude package could not be verified. Retry installation.",
            );
          const output = yield* run(paths.binaryPath, ["--version"], env);
          if (parseGenericCliVersion(output) !== version)
            return yield* fail(
              "verify",
              "The installed Claude version could not be verified. Retry installation.",
            );
          running = undefined;
          yield* SubscriptionRef.update(state, (current): ProviderInstallState => ({
            ...current,
            phase: "succeeded",
            version,
            installedVersion: version,
            executablePath: paths.binaryPath,
            message: "Claude installed.",
          }));
        }).pipe(
          Effect.timeout("30 minutes"),
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.void;
            const error = Cause.squash(cause);
            running = undefined;
            return SubscriptionRef.update(state, (current): ProviderInstallState => ({
              ...current,
              phase: "failed",
              message: isInstallationError(error)
                ? error.detail
                : "Claude installation failed. Check npm access and retry.",
            })).pipe(
              Effect.andThen(Effect.logWarning("Claude npm installation failed", { cause })),
            );
          }),
          Effect.ensuring(
            Effect.sync(() => {
              if (running?.operationId === operationId) running = undefined;
            }),
          ),
        );
        const fiber = yield* install.pipe(Effect.forkIn(scope));
        running = { operationId, fiber };
        return yield* SubscriptionRef.get(state);
      }),
    );
  });
  const cancel = Effect.fn("ClaudeInstallation.cancel")(function* (operationId: string) {
    return yield* gate.withPermit(
      Effect.gen(function* () {
        if (running?.operationId !== operationId) return yield* SubscriptionRef.get(state);
        yield* Fiber.interrupt(running.fiber);
        yield* SubscriptionRef.update(state, (current): ProviderInstallState => ({
          ...current,
          phase: "cancelled",
          message: "Installation cancelled.",
        }));
        return yield* SubscriptionRef.get(state);
      }),
    );
  });
  const remove = Effect.fn("ClaudeInstallation.remove")(function* (
    protectedPaths: ReadonlyArray<string> = [],
  ) {
    return yield* gate.withPermit(
      Effect.gen(function* () {
        if (running)
          return yield* fail(
            "remove-install",
            "Cancel the Claude installation before removing it.",
          );
        if (
          protectedPaths.some((file) => {
            const relative = path.relative(paths.directory, path.resolve(file));
            return (
              relative === "" ||
              (!relative.startsWith(`..${path.sep}`) &&
                relative !== ".." &&
                !path.isAbsolute(relative))
            );
          })
        )
          return yield* fail(
            "remove-install",
            "Another provider uses this installation. Change its binary path before removing Claude.",
          );
        yield* fs
          .remove(paths.directory, { recursive: true, force: true })
          .pipe(
            Effect.mapError((cause) =>
              fail("remove-install", "Could not remove the managed Claude installation.", cause),
            ),
          );
        yield* SubscriptionRef.update(state, (current): ProviderInstallState => ({
          ...current,
          phase: "idle",
          installedVersion: null,
          executablePath: null,
          canRemove: false,
          message: null,
        }));
      }),
    );
  });
  return ClaudeInstallation.of({
    start,
    cancel,
    remove,
    state: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
  });
});

export const layer = Layer.effect(ClaudeInstallation, make());

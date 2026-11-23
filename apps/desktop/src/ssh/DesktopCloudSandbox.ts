import type { DesktopCloudSandboxConfig, DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

const StoredConfig = Schema.fromJsonString(
  Schema.Struct({
    hostname: Schema.NonEmptyString,
    port: Schema.Int,
    password: Schema.RedactedFromValue(Schema.NonEmptyString),
  }),
);

const decodeStoredConfig = Schema.decodeEffect(StoredConfig);
const encodeStoredConfig = Schema.encodeEffect(StoredConfig);

class CloudSandboxError extends Schema.TaggedError<
  CloudSandboxError,
  { readonly brand: unique symbol }
>()("CloudSandboxError", {
  message: Schema.String,
}) {}

function endpoint(host: string, defaultPort = 22) {
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9][a-z0-9._-]*)(?::(\d+))?$/iu.exec(host.trim());
  const port = match?.[2] === undefined ? defaultPort : Number(match[2]);
  if (!match?.[1] || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const hostname = match[1].toLowerCase();
  if (!hostname.startsWith("[")) return { hostname, port };
  try {
    return { hostname: new URL(`http://${hostname}`).hostname.slice(1, -1), port };
  } catch {
    return null;
  }
}

function sameEndpoint(left: DesktopCloudSandboxConfig, right: DesktopCloudSandboxConfig) {
  return (
    left !== null && right !== null && left.hostname === right.hostname && left.port === right.port
  );
}

export class DesktopCloudSandbox extends Context.Service<
  DesktopCloudSandbox,
  {
    readonly get: Effect.Effect<DesktopCloudSandboxConfig, CloudSandboxError>;
    readonly save: (input: {
      readonly host: string;
      readonly password?: Redacted.Redacted<string>;
    }) => Effect.Effect<DesktopCloudSandboxConfig, CloudSandboxError>;
    readonly clear: Effect.Effect<void, CloudSandboxError>;
    readonly passwordFor: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<Redacted.Redacted<string> | undefined, CloudSandboxError>;
  }
>()("@t3tools/desktop/ssh/DesktopCloudSandbox") {}

export const make = Effect.fn("desktop.cloudSandbox.make")(function* (stateDir: string) {
  const storage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(stateDir, "cloud-sandbox-ssh");
  const lock = yield* Semaphore.make(1);
  const protect = Effect.gen(function* () {
    const backend = yield* storage.selectedStorageBackend;
    const available = yield* storage.isEncryptionAvailable.pipe(Effect.orElseSucceed(() => false));
    if (!available || Option.contains(backend, "basic_text")) {
      return yield* new CloudSandboxError({ message: "Secure credential storage is unavailable." });
    }
  });
  const read = Effect.fn("desktop.cloudSandbox.read")(
    function* () {
      const bytes = yield* fs.readFile(file).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeedNone,
        ),
      );
      if (Option.isNone(bytes)) return null;
      yield* protect;
      const contents = yield* storage.decryptString(bytes.value);
      return yield* decodeStoredConfig(contents);
    },
    Effect.mapError(
      () => new CloudSandboxError({ message: "Could not read the Cloud Sandbox credential." }),
    ),
  );

  return DesktopCloudSandbox.of({
    get: read().pipe(
      Effect.map((stored) =>
        stored === null ? null : { hostname: stored.hostname, port: stored.port },
      ),
    ),
    save: Effect.fn("desktop.cloudSandbox.save")(
      function* (input) {
        const next = endpoint(input.host);
        if (next === null)
          return yield* new CloudSandboxError({ message: "Enter a valid SSH host and port." });
        let password = input.password;
        if (password === undefined) {
          const previous = yield* read();
          if (previous === null || !sameEndpoint(previous, next)) {
            return yield* new CloudSandboxError({ message: "Enter a password for this SSH host." });
          }
          password = previous.password;
        }
        yield* protect;
        yield* Effect.gen(function* () {
          const contents = yield* encodeStoredConfig({ ...next, password });
          const encrypted = yield* storage.encryptString(contents);
          yield* fs.makeDirectory(stateDir, { recursive: true });
          const temp = yield* fs.makeTempFileScoped({
            directory: stateDir,
            prefix: "cloud-sandbox-ssh-",
          });
          yield* fs.writeFile(temp, encrypted, { mode: 0o600 });
          yield* fs.rename(temp, file);
        }).pipe(
          Effect.scoped,
          Effect.mapError(
            () =>
              new CloudSandboxError({ message: "Could not save the Cloud Sandbox credential." }),
          ),
        );
        return next;
      },
      (effect) => lock.withPermit(effect),
    ),
    clear: lock
      .withPermit(fs.remove(file, { force: true }))
      .pipe(
        Effect.mapError(
          () => new CloudSandboxError({ message: "Could not clear the Cloud Sandbox credential." }),
        ),
      ),
    passwordFor: Effect.fn("desktop.cloudSandbox.passwordFor")(function* (target) {
      const stored = yield* read();
      const host = target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname;
      return sameEndpoint(stored, endpoint(host, target.port ?? 22)) ? stored?.password : undefined;
    }),
  });
});

export const layer = Layer.effect(
  DesktopCloudSandbox,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* make(environment.stateDir);
  }),
);

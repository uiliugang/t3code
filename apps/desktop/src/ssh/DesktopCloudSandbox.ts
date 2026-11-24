import {
  parseDesktopCloudSandboxEndpoint,
  type DesktopCloudSandboxConfig,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
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

const StoredCredential = Schema.Struct({
  hostname: Schema.NonEmptyString,
  port: Schema.Int,
  password: Schema.RedactedFromValue(Schema.NonEmptyString),
});
const StoredConfigs = Schema.Array(StoredCredential);
const decodeStoredConfig = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Union([StoredConfigs, StoredCredential])),
);
const encodeStoredConfig = Schema.encodeEffect(Schema.fromJsonString(StoredConfigs));

class CloudSandboxError extends Schema.TaggedError<
  CloudSandboxError,
  { readonly brand: unique symbol }
>()("CloudSandboxError", {
  message: Schema.String,
}) {}
const isCloudSandboxError = Schema.is(CloudSandboxError);

function sameEndpoint(left: DesktopCloudSandboxConfig, right: DesktopCloudSandboxConfig) {
  return left.hostname === right.hostname && left.port === right.port;
}

const metadata = (stored: typeof StoredConfigs.Type) =>
  stored.map(({ hostname, port }) => ({ hostname, port }));

export class DesktopCloudSandbox extends Context.Service<
  DesktopCloudSandbox,
  {
    readonly get: Effect.Effect<readonly DesktopCloudSandboxConfig[], CloudSandboxError>;
    readonly save: (input: {
      readonly host: string;
      readonly previous?: DesktopCloudSandboxConfig;
      readonly password?: Redacted.Redacted<string>;
    }) => Effect.Effect<readonly DesktopCloudSandboxConfig[], CloudSandboxError>;
    readonly clear: (
      target: DesktopCloudSandboxConfig,
    ) => Effect.Effect<readonly DesktopCloudSandboxConfig[], CloudSandboxError>;
    readonly reset: Effect.Effect<void, CloudSandboxError>;
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
    function* (): Effect.fn.Return<typeof StoredConfigs.Type, unknown> {
      const bytes = yield* fs.readFile(file).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeedNone,
        ),
      );
      if (Option.isNone(bytes)) return [];
      yield* protect;
      const contents = yield* storage.decryptString(bytes.value);
      const stored = yield* decodeStoredConfig(contents);
      return "hostname" in stored ? [stored] : stored;
    },
    Effect.mapError(
      () => new CloudSandboxError({ message: "Could not read the Cloud Sandbox credential." }),
    ),
  );

  const write = Effect.fn("desktop.cloudSandbox.write")(function* (
    stored: typeof StoredConfigs.Type,
  ) {
    if (stored.length === 0) {
      yield* fs.remove(file, { force: true });
      return;
    }
    yield* protect;
    const contents = yield* encodeStoredConfig(stored);
    const encrypted = yield* storage.encryptString(contents);
    yield* fs.makeDirectory(stateDir, { recursive: true });
    const temp = yield* fs.makeTempFileScoped({
      directory: stateDir,
      prefix: "cloud-sandbox-ssh-",
    });
    yield* fs.writeFile(temp, encrypted, { mode: 0o600 });
    yield* fs.rename(temp, file);
  }, Effect.scoped);

  return DesktopCloudSandbox.of({
    get: read().pipe(Effect.map(metadata)),
    save: Effect.fn("desktop.cloudSandbox.save")(
      function* (input) {
        const next = parseDesktopCloudSandboxEndpoint(input.host);
        if (next === null)
          return yield* new CloudSandboxError({ message: "Enter a valid SSH host and port." });
        const stored = yield* read();
        const existing = stored.find((entry) => sameEndpoint(entry, next));
        const previous = input.previous ?? next;
        const unchanged = sameEndpoint(previous, next);
        if (existing && (!input.previous || !unchanged)) {
          return yield* new CloudSandboxError({
            message: "This SSH endpoint is already configured.",
          });
        }
        const password = input.password ?? (unchanged ? existing?.password : undefined);
        if (password === undefined) {
          return yield* new CloudSandboxError({ message: "Enter a password for this SSH host." });
        }
        const entry = { ...next, password };
        const updated = stored.some((candidate) => sameEndpoint(candidate, previous))
          ? stored.map((candidate) => (sameEndpoint(candidate, previous) ? entry : candidate))
          : [...stored, entry];
        yield* write(updated).pipe(
          Effect.mapError((error) =>
            isCloudSandboxError(error)
              ? error
              : new CloudSandboxError({ message: "Could not save the Cloud Sandbox credential." }),
          ),
        );
        return metadata(updated);
      },
      (effect) => lock.withPermit(effect),
    ),
    clear: Effect.fn("desktop.cloudSandbox.clear")(
      function* (target) {
        const stored = yield* read();
        const updated = stored.filter((entry) => !sameEndpoint(entry, target));
        if (updated.length !== stored.length) yield* write(updated);
        return metadata(updated);
      },
      (effect) =>
        lock
          .withPermit(effect)
          .pipe(
            Effect.mapError(
              () =>
                new CloudSandboxError({ message: "Could not clear the Cloud Sandbox credential." }),
            ),
          ),
    ),
    reset: lock
      .withPermit(fs.remove(file, { force: true }))
      .pipe(
        Effect.mapError(
          () =>
            new CloudSandboxError({ message: "Could not reset the Cloud Sandbox credentials." }),
        ),
      ),
    passwordFor: Effect.fn("desktop.cloudSandbox.passwordFor")(function* (target) {
      const stored = yield* read();
      const host = target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname;
      const resolved = parseDesktopCloudSandboxEndpoint(host, target.port ?? 22);
      return resolved ? stored.find((entry) => sameEndpoint(entry, resolved))?.password : undefined;
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

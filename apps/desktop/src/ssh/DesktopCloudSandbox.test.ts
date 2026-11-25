import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { make } from "./DesktopCloudSandbox.ts";

const storage = (backend: string) =>
  Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(true),
    selectedStorageBackend: Effect.succeedSome(backend),
    encryptString: (value) => Effect.succeed(Buffer.from(Buffer.from(value).toString("base64"))),
    decryptString: (bytes) =>
      Effect.succeed(Buffer.from(Buffer.from(bytes).toString(), "base64").toString()),
  });

it.effect("stores only encrypted credentials and matches the resolved endpoint exactly", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const sandbox = yield* make(dir);
    const target = {
      alias: "sandbox",
      hostname: "sandbox.example.test",
      username: "root",
      port: 2222,
    };
    yield* sandbox.save({
      host: "SANDBOX.example.test:2222",
      password: Redacted.make("fixture-password"),
    });
    assert.notInclude(
      yield* fs.readFileString(path.join(dir, "cloud-sandbox-ssh")),
      "fixture-password",
    );
    const restarted = yield* make(dir);
    assert.deepEqual(yield* restarted.get, [{ hostname: target.hostname, port: 2222 }]);
    assert.equal(Redacted.value((yield* restarted.passwordFor(target))!), "fixture-password");
    assert.isUndefined(
      yield* restarted.passwordFor({ ...target, hostname: "other.sandbox.example.test" }),
    );
    assert.isUndefined(yield* restarted.passwordFor({ ...target, port: 22 }));
    yield* restarted.save({ host: "sandbox.example.test:2222", previous: target });
    yield* restarted.save({ host: "sandbox.example.test" }).pipe(Effect.flip);
    yield* restarted.clear(target);
    yield* restarted.clear(target);
    assert.deepEqual(yield* restarted.get, []);
    assert.isUndefined(yield* restarted.passwordFor(target));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, storage("keychain")))),
);

it.effect("reads legacy credentials and updates or removes only the selected endpoint", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
    const legacy = { hostname: "sandbox.example.test", port: 22 };
    const second = { hostname: legacy.hostname, port: 2222 };
    const target = { ...legacy, alias: "sandbox", username: "root" };
    const credential = Schema.Struct({
      hostname: Schema.NonEmptyString,
      port: Schema.Int,
      password: Schema.RedactedFromValue(Schema.NonEmptyString),
    });
    const legacyFormat = Schema.fromJsonString(credential);
    const multiple = Schema.Array(credential);
    const file = path.join(dir, "cloud-sandbox-ssh");
    const readLegacy = fs
      .readFile(file)
      .pipe(
        Effect.flatMap(safeStorage.decryptString),
        Effect.flatMap(Schema.decodeEffect(legacyFormat)),
      );
    const contents = yield* Schema.encodeEffect(legacyFormat)({
      ...legacy,
      password: Redacted.make("legacy-password"),
    });
    yield* fs.writeFile(file, yield* safeStorage.encryptString(contents));
    const sandbox = yield* make(dir);
    assert.deepEqual(yield* sandbox.get, [legacy]);
    yield* sandbox.save({
      host: legacy.hostname,
      previous: legacy,
      password: Redacted.make("updated-password"),
    });
    assert.equal(Redacted.value((yield* readLegacy).password), "updated-password");
    yield* sandbox.save({ host: "sandbox.example.test:2222", password: Redacted.make("second") });
    const rollback = yield* fs
      .readFile(file)
      .pipe(
        Effect.flatMap(safeStorage.decryptString),
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(Schema.Union([multiple, credential]))),
        ),
      );
    const entries = "hostname" in rollback ? [rollback] : rollback;
    const edited = entries.map((entry) =>
      entry.port === legacy.port ? { ...entry, password: Redacted.make("rollback-edit") } : entry,
    );
    const arrayContents = yield* Schema.encodeEffect(Schema.fromJsonString(multiple))(edited);
    yield* fs.writeFile(file, yield* safeStorage.encryptString(arrayContents));
    const restarted = yield* make(dir);
    assert.deepEqual(yield* restarted.get, [legacy, second]);
    assert.equal(Redacted.value((yield* restarted.passwordFor(target))!), "rollback-edit");
    assert.equal(
      Redacted.value((yield* restarted.passwordFor({ ...target, ...second }))!),
      "second",
    );
    yield* restarted
      .save({
        host: "sandbox.example.test:2222",
        previous: legacy,
        password: Redacted.make("duplicate"),
      })
      .pipe(Effect.flip);
    yield* restarted.save({ host: "other.example.test", previous: legacy }).pipe(Effect.flip);
    yield* restarted.save({
      host: "other.example.test",
      previous: legacy,
      password: Redacted.make("replacement"),
    });
    assert.isUndefined(yield* restarted.passwordFor(target));
    yield* restarted.clear(second);
    assert.deepEqual(yield* restarted.get, [{ hostname: "other.example.test", port: 22 }]);
    assert.equal(Redacted.value((yield* readLegacy).password), "replacement");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, storage("keychain")))),
);

it.effect("reads the array format and promotes the remaining endpoint after removal", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
    const first = { hostname: "one.example.test", port: 22 };
    const second = { hostname: "two.example.test", port: 2222 };
    const encrypted = yield* safeStorage.encryptString(
      JSON.stringify([
        { ...first, password: "first" },
        { ...second, password: "second" },
      ]),
    );
    yield* fs.writeFile(path.join(dir, "cloud-sandbox-ssh"), encrypted);
    const sandbox = yield* make(dir);
    assert.deepEqual(yield* sandbox.get, [first, second]);
    yield* sandbox.clear(first);
    const restarted = yield* make(dir);
    assert.deepEqual(yield* restarted.get, [second]);
    const target = { ...second, alias: "two", username: "root" };
    assert.equal(Redacted.value((yield* restarted.passwordFor(target))!), "second");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, storage("keychain")))),
);

it.effect("refuses to write credentials using Electron's plaintext backend", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const sandbox = yield* make(dir);
    const failure = yield* sandbox
      .save({ host: "sandbox.example.test", password: Redacted.make("fixture-password") })
      .pipe(Effect.flip);
    assert.include(failure.message, "Secure credential storage");
    assert.isFalse(yield* fs.exists(path.join(dir, "cloud-sandbox-ssh")));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, storage("basic_text")))),
);

it.effect("resets an unreadable credential file so new servers can be saved", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const file = path.join(dir, "cloud-sandbox-ssh");
    yield* fs.writeFileString(file, "unreadable credential file");
    const sandbox = yield* make(dir);
    yield* sandbox.get.pipe(Effect.flip);
    yield* sandbox.reset;
    assert.isFalse(yield* fs.exists(file));
    assert.deepEqual(
      yield* sandbox.save({ host: "new.example.test", password: Redacted.make("new-password") }),
      [{ hostname: "new.example.test", port: 22 }],
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, storage("keychain")))),
);

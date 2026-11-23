import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

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
    assert.deepEqual(yield* restarted.get, { hostname: target.hostname, port: 2222 });
    assert.equal(Redacted.value((yield* restarted.passwordFor(target))!), "fixture-password");
    assert.isUndefined(
      yield* restarted.passwordFor({ ...target, hostname: "other.sandbox.example.test" }),
    );
    assert.isUndefined(yield* restarted.passwordFor({ ...target, port: 22 }));
    yield* restarted.save({ host: "sandbox.example.test:2222" });
    yield* restarted.save({ host: "sandbox.example.test" }).pipe(Effect.flip);
    yield* restarted.clear;
    yield* restarted.clear;
    assert.isNull(yield* restarted.get);
    assert.isUndefined(yield* restarted.passwordFor(target));
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

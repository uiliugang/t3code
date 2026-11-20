import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import { withCheckLock } from "./check-changed-lock.ts";

it.effect("serializes independent checks and cancels waiters without releasing the owner", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const lockPath = path.join(directory, "checks.sqlite");
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const owner = yield* withCheckLock(
      lockPath,
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    let executions = 0;
    const run = withCheckLock(
      lockPath,
      Effect.sync(() => ++executions),
    );
    const cancelled = yield* run.pipe(Effect.forkChild);
    const next = yield* run.pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    assert.strictEqual(executions, 0);
    yield* Fiber.interrupt(cancelled);
    yield* TestClock.adjust("1 second");
    assert.strictEqual(executions, 0);
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(owner);
    yield* TestClock.adjust("1 second");
    assert.strictEqual(yield* Fiber.join(next), 1);
    assert.strictEqual(yield* run, 2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("releases the check lock after failure and interruption", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const lockPath = path.join(directory, "checks.sqlite");
    const invalid = yield* withCheckLock(directory, Effect.void).pipe(Effect.flip);
    assert.strictEqual(invalid._tag, "CheckLockError");
    assert.strictEqual(
      yield* withCheckLock(lockPath, Effect.fail("failed")).pipe(Effect.flip),
      "failed",
    );
    const started = yield* Deferred.make<void>();
    const owner = yield* withCheckLock(
      lockPath,
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(owner);
    assert.strictEqual(yield* withCheckLock(lockPath, Effect.succeed("passed")), "passed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("reclaims the lock after its owning process exits without cleanup", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped();
    const lockPath = path.join(directory, "checks.sqlite");
    const owner = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [
        "--input-type=module",
        "-e",
        `import { DatabaseSync } from "node:sqlite";
       const database = new DatabaseSync(process.argv[1]);
       database.exec("BEGIN IMMEDIATE");
       process.stdout.write("locked");
       process.stdin.resume();`,
        lockPath,
      ]),
    );
    const ready = yield* owner.stdout.pipe(Stream.decodeText(), Stream.runHead);
    assert.strictEqual(Option.getOrThrow(ready), "locked");
    yield* owner.kill({ killSignal: "SIGKILL" });
    yield* owner.exitCode.pipe(Effect.exit);
    assert.strictEqual(yield* withCheckLock(lockPath, Effect.succeed("passed")), "passed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

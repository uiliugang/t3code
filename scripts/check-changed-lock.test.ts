import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import { withBrowserTestLock, withCheckLock, withSlotLock } from "./check-changed-lock.ts";

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
    assert.include(invalid.message, directory);
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

it.effect("bounds concurrency to configured slots and logs a custom waiting message once", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const lockPath = path.join(directory, "t3-browser-test.sqlite");
    const logs: Array<string> = [];
    const testConsole: Console.Console = Object.assign(Object.create(console), {
      log: (...args: ReadonlyArray<unknown>) => {
        logs.push(args.map(String).join(" "));
      },
    });

    let active = 0;
    let maxActive = 0;
    const started1 = yield* Deferred.make<void>();
    const started2 = yield* Deferred.make<void>();
    const release1 = yield* Deferred.make<void>();
    const release2 = yield* Deferred.make<void>();
    const started3 = yield* Deferred.make<void>();

    const runSlot = (started: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
      withSlotLock(
        lockPath,
        Effect.gen(function* () {
          active += 1;
          maxActive = Math.max(maxActive, active);
          yield* Deferred.succeed(started, undefined);
          return yield* Deferred.await(release).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active -= 1;
              }),
            ),
          );
        }),
        { slots: 2, waitingMessage: "waiting for browser slot" },
      ).pipe(Effect.provideService(Console.Console, testConsole));

    const first = yield* runSlot(started1, release1).pipe(Effect.forkChild);
    const second = yield* runSlot(started2, release2).pipe(Effect.forkChild);
    yield* Deferred.await(started1);
    yield* Deferred.await(started2);
    assert.strictEqual(active, 2);

    const third = yield* runSlot(started3, release2).pipe(Effect.forkChild);
    yield* TestClock.adjust("3 seconds");
    assert.strictEqual(active, 2);
    assert.deepStrictEqual(logs, ["waiting for browser slot"]);

    // A caller using default slots=1 shares slot 1 (`lockPath`) with slots=2 callers.
    const singleStarted = yield* Deferred.make<void>();
    const singleRelease = yield* Deferred.make<void>();
    const singleSlotCaller = yield* withCheckLock(
      lockPath,
      Deferred.succeed(singleStarted, undefined).pipe(
        Effect.andThen(Deferred.await(singleRelease)),
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust("1 second");
    assert.isFalse(yield* Deferred.isDone(singleStarted));

    yield* Deferred.succeed(release1, undefined);
    yield* Fiber.join(first);
    yield* TestClock.adjust("1 second");
    // `third` (slots=2) or `singleSlotCaller` (slots=1) takes slot 1, leaving total active <= 2.
    yield* Deferred.await(started3);
    assert.strictEqual(active, 2);
    assert.strictEqual(maxActive, 2);
    assert.isFalse(yield* Deferred.isDone(singleStarted));

    yield* Deferred.succeed(release2, undefined);
    yield* Fiber.join(second);
    yield* Fiber.join(third);
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(singleStarted);
    yield* Deferred.succeed(singleRelease, undefined);
    yield* Fiber.join(singleSlotCaller);

    assert.isTrue(yield* fs.exists(lockPath));
    assert.isFalse(yield* fs.exists(path.join(directory, "t3-browser-test-slot-1.sqlite")));
    assert.isTrue(yield* fs.exists(path.join(directory, "t3-browser-test-slot-2.sqlite")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reads T3_BROWSER_TEST_CONCURRENCY and rejects non-positive values", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const withEnv = (entries: Record<string, string>) =>
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: entries })));

    const invalid = yield* withBrowserTestLock(directory, Effect.void).pipe(
      withEnv({ T3_BROWSER_TEST_CONCURRENCY: "0" }),
      Effect.flip,
    );
    assert.strictEqual(invalid, "T3_BROWSER_TEST_CONCURRENCY must be a positive integer.");

    const nonNumeric = yield* withBrowserTestLock(directory, Effect.void).pipe(
      withEnv({ T3_BROWSER_TEST_CONCURRENCY: "abc" }),
      Effect.flip,
    );
    assert.strictEqual(nonNumeric, "T3_BROWSER_TEST_CONCURRENCY must be a positive integer.");

    const passed = yield* withBrowserTestLock(directory, Effect.succeed("ok")).pipe(
      withEnv({ T3_BROWSER_TEST_CONCURRENCY: "2" }),
    );
    assert.strictEqual(passed, "ok");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

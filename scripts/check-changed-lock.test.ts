// @effect-diagnostics nodeBuiltinImport:off - live subprocess tests inspect the real sidecar file on disk.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, expect, it } from "@effect/vitest";
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

import {
  collectDescendantProcessGroups,
  terminateTrackedProcessGroups,
  trackDescendantProcessGroups,
  withBrowserTestLock,
  withCheckLock,
  withSlotLock,
} from "./check-changed-lock.ts";

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

it("collects distinct descendant process groups, enforces ancestry, and skips recycled PIDs on termination", () => {
  const snapshot = [
    { pid: 10, ppid: 1, pgid: 10, lstart: "Thu Nov 26 18:00:00 2026" },
    { pid: 20, ppid: 10, pgid: 20, lstart: "Thu Nov 26 18:00:01 2026" },
    { pid: 21, ppid: 20, pgid: 20, lstart: "Thu Nov 26 18:00:01 2026" },
    // Double-detached grandchild (e.g. Playwright chrome-headless-shell).
    { pid: 30, ppid: 21, pgid: 30, lstart: "Thu Nov 26 18:00:02 2026" },
    { pid: 31, ppid: 30, pgid: 30, lstart: "Thu Nov 26 18:00:02 2026" },
    { pid: 99, ppid: 1, pgid: 99, lstart: "Thu Nov 26 18:00:00 2026" },
  ];
  // Unrelated PID 99 (not a descendant of ancestor 10) must be ignored.
  assert.deepStrictEqual(collectDescendantProcessGroups(99, snapshot, 10, 10), []);

  const groups = collectDescendantProcessGroups(20, snapshot, 10, 10);
  assert.deepStrictEqual(
    groups.map((g) => g.pgid).toSorted((a, b) => a - b),
    [20, 30],
  );

  // Simulate:
  // - pgid 20 was recycled before SIGTERM -> must not receive SIGTERM or SIGKILL.
  // - pgid 30 matches initially, survives grace, and still matches -> receives SIGTERM + SIGKILL.
  // - pgid 40 matches initially, exits and is recycled during grace -> receives SIGTERM only, NOT SIGKILL.
  const allGroups = [
    ...groups,
    { pgid: 40, members: [{ pid: 40, lstart: "Thu Nov 26 18:00:03 2026" }] },
  ];
  let snapshotCalls = 0;
  const signals: Array<{ pgid: number; signal: NodeJS.Signals | 0 }> = [];
  terminateTrackedProcessGroups(allGroups, {
    platform: "darwin",
    graceMs: 25,
    snapshot: () => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) {
        return [
          { pid: 20, ppid: 1, pgid: 20, lstart: "Thu Nov 26 19:59:59 2026" },
          { pid: 30, ppid: 1, pgid: 30, lstart: "Thu Nov 26 18:00:02 2026" },
          { pid: 40, ppid: 1, pgid: 40, lstart: "Thu Nov 26 18:00:03 2026" },
        ];
      }
      return [
        { pid: 30, ppid: 1, pgid: 30, lstart: "Thu Nov 26 18:00:02 2026" },
        { pid: 40, ppid: 1, pgid: 40, lstart: "Thu Nov 26 19:59:59 2026" },
      ];
    },
    signalGroup: (pgid, signal) => {
      signals.push({ pgid, signal });
    },
    wait: () => {},
  });
  assert.deepStrictEqual(
    signals.filter((s) => s.signal !== 0),
    [
      { pgid: 30, signal: "SIGTERM" },
      { pgid: 40, signal: "SIGTERM" },
      { pgid: 30, signal: "SIGKILL" },
    ],
  );
});

it.live(
  "isolates nested lock cleanup from parallel sibling steps, kills double-detached grandchildren on interruption, and reaps delayed grandchildren after SIGKILL",
  () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      if (platform === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped();
      const lockPath = path.join(directory, "checks.sqlite");
      const innerLockPath = path.join(directory, "browser.sqlite");
      const grandchildPidFile = path.join(directory, "grandchild.pid");

      const isAlive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      // Case 1: releasing an inner lock must NOT kill a still-running sibling child
      // spawned under the outer lock.
      const siblingReady = yield* Deferred.make<void>();
      const releaseSibling = yield* Deferred.make<void>();
      const siblingPid = yield* Deferred.make<number>();
      yield* withCheckLock(
        lockPath,
        Effect.gen(function* () {
          const sibling = yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make(
                  process.execPath,
                  ["-e", 'process.stdout.write("sibling"); setInterval(() => {}, 1000);'],
                  { forceKillAfter: "5 seconds" },
                ),
              );
              yield* trackDescendantProcessGroups(Number(handle.pid));
              const head = yield* handle.stdout.pipe(Stream.decodeText(), Stream.runHead);
              assert.strictEqual(Option.getOrThrow(head), "sibling");
              yield* Deferred.succeed(siblingPid, Number(handle.pid));
              yield* Deferred.succeed(siblingReady, undefined);
              yield* Deferred.await(releaseSibling);
              return yield* handle.kill();
            }),
          ).pipe(Effect.forkChild);

          yield* Deferred.await(siblingReady);
          // Acquire and release an inner lock while the sibling is still running.
          yield* withSlotLock(innerLockPath, Effect.void);
          assert.isTrue(isAlive(yield* Deferred.await(siblingPid)));

          yield* Deferred.succeed(releaseSibling, undefined);
          yield* Fiber.join(sibling);
        }),
      );

      // Case 2: scope interruption kills a detached grandchild in its own PGID.
      const started1 = yield* Deferred.make<void>();
      const runner = yield* withCheckLock(
        lockPath,
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(
                process.execPath,
                [
                  "--input-type=module",
                  "-e",
                  `import { spawn } from "node:child_process";
                   import { writeFileSync } from "node:fs";
                   const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
                     detached: true,
                     stdio: "ignore",
                   });
                   writeFileSync(process.argv[1], String(grandchild.pid));
                   process.stdout.write("ready");
                   setInterval(() => {}, 1000);`,
                  grandchildPidFile,
                ],
                { forceKillAfter: "5 seconds" },
              ),
            );
            yield* trackDescendantProcessGroups(Number(handle.pid));
            const head = yield* handle.stdout.pipe(Stream.decodeText(), Stream.runHead);
            assert.strictEqual(Option.getOrThrow(head), "ready");
            yield* Deferred.succeed(started1, undefined);
            return yield* handle.exitCode;
          }),
        ),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(started1);
      const grandchild1 = Number((yield* fs.readFileString(grandchildPidFile)).trim());
      assert.isTrue(isAlive(grandchild1));

      yield* Fiber.interrupt(runner);
      assert.isFalse(isAlive(grandchild1));

      // Case 3: if a lock holder spawns a child that spawns a double-detached grandchild
      // after the initial snapshot (discovered by the 1s polling loop) and the holder is
      // SIGKILLed, the next withCheckLock acquisition reaps the grandchild from the sidecar.
      const leakedPidFile = path.join(directory, "leaked.pid");
      const sidecarPath = `${lockPath}.groups.json`;
      const lockModuleUrl = new URL("./check-changed-lock.ts", import.meta.url).href;
      const holder = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { spawn } from "node:child_process";
             import * as NodeServices from "@effect/platform-node/NodeServices";
             import * as Effect from "effect/Effect";
             import { trackDescendantProcessGroups, withCheckLock } from ${JSON.stringify(lockModuleUrl)};

             const program = withCheckLock(
               process.argv[1],
               Effect.scoped(
                 Effect.gen(function* () {
                   const middle = spawn(
                     process.execPath,
                     [
                       "--input-type=module",
                       "-e",
                       \`import { spawn } from "node:child_process";
                        import { writeFileSync } from "node:fs";
                        setTimeout(() => {
                          const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
                            detached: true,
                            stdio: "ignore",
                          });
                          writeFileSync(process.argv[1], String(grandchild.pid));
                        }, 150);
                        setInterval(() => {}, 1000);\`,
                       process.argv[2],
                     ],
                     { detached: true, stdio: "ignore" },
                   );
                   yield* trackDescendantProcessGroups(middle.pid);
                   process.stdout.write("holder-ready");
                   yield* Effect.never;
                 }),
               ),
             );
             Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)));`,
            lockPath,
            leakedPidFile,
          ],
          { cwd: import.meta.dirname },
        ),
      );
      const holderReady = yield* holder.stdout.pipe(Stream.decodeText(), Stream.runHead);
      assert.strictEqual(Option.getOrThrow(holderReady), "holder-ready");

      // Wait for the delayed grandchild to start and the 1s async poller to persist its PGID.
      let leakedPid = 0;
      yield* Effect.promise(() =>
        expect
          .poll(
            () => {
              if (!NodeFS.existsSync(leakedPidFile) || !NodeFS.existsSync(sidecarPath)) return 0;
              const parsed = Number(NodeFS.readFileSync(leakedPidFile, "utf8").trim());
              if (parsed <= 0) return 0;
              const sidecar = NodeFS.readFileSync(sidecarPath, "utf8");
              if (!sidecar.includes(String(parsed))) return 0;
              leakedPid = parsed;
              return parsed;
            },
            { timeout: 5_000, interval: 100 },
          )
          .toBeGreaterThan(0),
      );
      assert.isTrue(isAlive(leakedPid));

      // Kill ONLY the holder process (bypassing its finalizers), leaving the grandchild orphaned.
      process.kill(Number(holder.pid), "SIGKILL");
      yield* holder.exitCode.pipe(Effect.exit);
      assert.isTrue(isAlive(leakedPid));

      // Next lock acquisition must reap the leaked grandchild process group automatically.
      const result = yield* withCheckLock(lockPath, Effect.succeed("reaped"));
      assert.strictEqual(result, "reaped");
      assert.isFalse(isAlive(leakedPid));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

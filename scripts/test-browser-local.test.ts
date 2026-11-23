// @effect-diagnostics nodeBuiltinImport:off -- tests exercise cross-process SQLite locks and process group cleanup.
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import { withBrowserTestLock } from "./check-changed-lock.ts";
import { parseBrowserTestArgs, runBrowserTestLocal } from "./test-browser-local.ts";

const makeGitRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-browser-local-test-" });
  const emptyConfig = path.join(root, ".empty.gitconfig");
  yield* fs.writeFileString(emptyConfig, "");
  const cleanGitEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  NodeChildProcess.execFileSync("git", ["-c", "init.defaultBranch=main", "init"], {
    cwd: root,
    env: cleanGitEnv,
    stdio: "pipe",
  });
  return root;
});

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const assertImmediateLockAvailable = (filename: string): void => {
  const lockDb = new NodeSqlite.DatabaseSync(filename, { timeout: 0 });
  try {
    lockDb.exec("BEGIN IMMEDIATE");
    lockDb.exec("ROLLBACK");
  } finally {
    lockDb.close();
  }
};

describe("test:browser:local", () => {
  it("parses targets, value/boolean vitest flags, and interactive mode via Vitest CAC", () => {
    for (const missingTarget of [
      [],
      ["-t", "saves on Enter"],
      ["--test-name-pattern", "saves"],
      ["--reporters", "dot"],
      ["-p", "browser"],
      ["--bail", "1", "--testTimeout", "5000", "--browser.name", "chromium"],
      ["-u", "new"],
      ["--changed", "main"],
      ["--", "-t", "saves"],
    ]) {
      assert.isFalse(parseBrowserTestArgs(missingTarget).hasTarget, missingTarget.join(" "));
    }
    assert.deepStrictEqual(
      parseBrowserTestArgs(["--browser.headless", "apps/web/src/Foo.browser.test.tsx"]),
      {
        forwardedArgs: ["--browser.headless", "apps/web/src/Foo.browser.test.tsx"],
        help: false,
        hasTarget: true,
        interactive: false,
        specifiesFileParallelism: false,
      },
    );
    assert.deepStrictEqual(
      parseBrowserTestArgs(["apps/web/src/Foo.browser.test.tsx", "-t", "foo -h bar"]),
      {
        forwardedArgs: ["apps/web/src/Foo.browser.test.tsx", "-t", "foo -h bar"],
        help: false,
        hasTarget: true,
        interactive: false,
        specifiesFileParallelism: false,
      },
    );
    assert.deepStrictEqual(parseBrowserTestArgs(["--help"]), {
      forwardedArgs: ["--help"],
      help: true,
      hasTarget: false,
      interactive: false,
      specifiesFileParallelism: false,
    });
    assert.isTrue(
      parseBrowserTestArgs(["apps/web/src/Foo.browser.test.tsx", "--fileParallelism"])
        .specifiesFileParallelism,
    );
    assert.isTrue(
      parseBrowserTestArgs(["apps/web/src/Foo.browser.test.tsx", "--file-parallelism=true"])
        .specifiesFileParallelism,
    );
    assert.isTrue(
      parseBrowserTestArgs(["--", "-w", "apps/web/src/Foo.browser.test.tsx"]).interactive,
    );
    assert.isTrue(parseBrowserTestArgs(["--ui", "apps/web/src/Foo.browser.test.tsx"]).interactive);
  });

  it.effect("rejects invocations with no test target or interactive watch/UI flags", () =>
    Effect.gen(function* () {
      const errors: Array<string> = [];
      const testConsole: Console.Console = Object.assign(Object.create(console), {
        error: (...args: ReadonlyArray<unknown>) => {
          errors.push(args.map(String).join(" "));
        },
      });
      const spawner = ChildProcessSpawner.make(() =>
        Effect.die("should not spawn any process when rejected"),
      );

      for (const args of [
        [],
        ["-t", "saves on Enter"],
        ["--reporters", "dot"],
        ["-p", "browser"],
        ["--", "-t", "saves"],
        ["-w", "apps/web/src/Foo.browser.test.tsx"],
        ["--watch", "apps/web/src/Foo.browser.test.tsx"],
        ["--ui", "apps/web/src/Foo.browser.test.tsx"],
      ]) {
        const code = yield* runBrowserTestLocal(args).pipe(
          Effect.provideService(Console.Console, testConsole),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        assert.strictEqual(code, 1);
      }
      assert.strictEqual(errors.length, 8);
      assert.include(errors[0]!, "pass one or more test file or directory paths");
      assert.include(errors[5]!, "interactive watch/UI flags");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "waits for the repository browser lock before spawning vitest, forwards arguments, and honors T3_BROWSER_FILE_PARALLELISM=1",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-browser-local-test-" });
        const gitDir = path.join(root, ".git");
        yield* fs.makeDirectory(gitDir, { recursive: true });

        const spawnedCommands: Array<{
          command: string;
          args: ReadonlyArray<string>;
          cwd: string | undefined;
        }> = [];
        const testSpawner = ChildProcessSpawner.make((cmd) => {
          if (!ChildProcess.isStandardCommand(cmd)) {
            return Effect.die("expected standard command");
          }
          if (cmd.command === "git") {
            return Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(41),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: Stream.encodeText(Stream.make(".git\n")),
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            );
          }
          spawnedCommands.push({
            command: cmd.command,
            args: cmd.args.map(String),
            cwd: cmd.options.cwd,
          });
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(42),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(7)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });

        const logs: Array<string> = [];
        const testConsole: Console.Console = Object.assign(Object.create(console), {
          log: (...args: ReadonlyArray<unknown>) => {
            logs.push(args.map(String).join(" "));
          },
        });

        const holderStarted = yield* Deferred.make<void>();
        const releaseHolder = yield* Deferred.make<void>();
        const holder = yield* withBrowserTestLock(
          gitDir,
          Deferred.succeed(holderStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseHolder)),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(holderStarted);

        const waiter = yield* runBrowserTestLocal(
          ["--", "apps/web/src/components/Sidebar.browser.test.tsx", "-t", "drags"],
          { cwd: root },
        ).pipe(
          Effect.provideService(Console.Console, testConsole),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, testSpawner),
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.forkChild,
        );

        yield* TestClock.adjust("2 seconds");
        assert.deepStrictEqual(spawnedCommands, []);
        assert.deepStrictEqual(logs, [
          "test:browser:local: waiting for another browser test in this repository to finish.",
        ]);

        yield* Deferred.succeed(releaseHolder, undefined);
        yield* Fiber.join(holder);
        yield* TestClock.adjust("1 second");

        const exitCode = yield* Fiber.join(waiter);
        assert.strictEqual(exitCode, 7);

        yield* runBrowserTestLocal(["apps/web/src/components/Sidebar.browser.test.tsx"], {
          cwd: root,
        }).pipe(
          Effect.provideService(Console.Console, testConsole),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, testSpawner),
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { T3_BROWSER_FILE_PARALLELISM: "1" } }),
            ),
          ),
        );

        assert.deepStrictEqual(spawnedCommands, [
          {
            command: "vp",
            args: [
              "test",
              "run",
              "--no-file-parallelism",
              "apps/web/src/components/Sidebar.browser.test.tsx",
              "-t",
              "drags",
            ],
            cwd: root,
          },
          {
            command: "vp",
            args: ["test", "run", "apps/web/src/components/Sidebar.browser.test.tsx"],
            cwd: root,
          },
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("kills the spawned child process tree and hands off the lock on interruption", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* makeGitRepo;
      const pidFile = path.join(root, "grandchild.pid");

      const fakeVp = ChildProcess.make(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { spawn } from "node:child_process";
           import { writeFileSync } from "node:fs";
           const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
           writeFileSync(process.argv[1], String(child.pid));
           process.stdout.write("ready");
           setInterval(() => {}, 1000);`,
          pidFile,
        ],
        { cwd: root, forceKillAfter: "5 seconds" },
      );

      const started = yield* Deferred.make<void>();
      const interceptSpawner = ChildProcessSpawner.make((cmd) => {
        if (ChildProcess.isStandardCommand(cmd) && cmd.command !== "git") {
          return spawner.spawn(fakeVp).pipe(
            Effect.tap((handle) =>
              handle.stdout.pipe(
                Stream.decodeText(),
                Stream.runHead,
                Effect.flatMap((head) => {
                  assert.strictEqual(Option.getOrThrow(head), "ready");
                  return Deferred.succeed(started, undefined);
                }),
              ),
            ),
          );
        }
        return spawner.spawn(cmd);
      });

      const first = yield* runBrowserTestLocal(
        ["apps/web/src/components/Sidebar.browser.test.tsx"],
        { cwd: root },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, interceptSpawner),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.forkChild,
      );

      yield* Deferred.await(started);
      const grandchildPid = Number((yield* fs.readFileString(pidFile)).trim());
      assert.isAbove(grandchildPid, 0);

      yield* Fiber.interrupt(first);

      assert.isFalse(isPidAlive(grandchildPid));
      assertImmediateLockAvailable(path.join(root, ".git", "t3-browser-test.sqlite"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

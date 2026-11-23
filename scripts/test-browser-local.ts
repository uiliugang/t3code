import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { vitePlusCommand } from "./check-changed-command.ts";
import { withBrowserTestLock } from "./check-changed-lock.ts";

const USAGE = "Usage: vp run test:browser:local <test files or directories> [vitest options]";

const hasTargetArgument = (args: ReadonlyArray<string>): boolean => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return index + 1 < args.length;
    // Vitest flags that take a separate value argument rather than a positional test path.
    if (
      arg === "-t" ||
      arg === "--testNamePattern" ||
      arg === "-c" ||
      arg === "--config" ||
      arg === "--dir" ||
      arg === "--root" ||
      arg === "-r" ||
      arg === "--project" ||
      arg === "--reporter" ||
      arg === "--outputFile" ||
      arg === "--shard" ||
      arg === "--maxWorkers" ||
      arg === "--pool" ||
      arg === "--environment"
    ) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) return true;
  }
  return false;
};

const resolveGitCommonDir = Effect.fn("testBrowserLocal.gitCommonDir")(function* (cwd: string) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["-c", "core.quotePath=false", "rev-parse", "--git-common-dir"], {
          cwd,
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: 3 },
      );
      if (exitCode !== 0) {
        return yield* Effect.fail(
          `test:browser:local: git rev-parse --git-common-dir exited with ${exitCode}: ${stderr.trim()}`,
        );
      }
      return path.resolve(cwd, stdout.trim());
    }),
  );
});

export const runBrowserTestLocal = Effect.fn("testBrowserLocal.run")(function* (
  rawArgs: ReadonlyArray<string>,
  options: { readonly cwd?: string } = {},
) {
  const forwardedArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  if (forwardedArgs.includes("--help") || forwardedArgs.includes("-h")) {
    yield* Console.log(USAGE);
    return 0;
  }
  if (!hasTargetArgument(forwardedArgs)) {
    yield* Console.error(
      `test:browser:local: pass one or more test file or directory paths.\n${USAGE}`,
    );
    return 1;
  }

  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = options.cwd ?? (yield* path.fromFileUrl(new URL("..", import.meta.url)));
  const commonDir = yield* resolveGitCommonDir(root);

  return yield* withBrowserTestLock(
    commonDir,
    Effect.scoped(
      Effect.gen(function* () {
        const [command, commandArgs] = vitePlusCommand(
          ["test", "run", "--no-file-parallelism", ...forwardedArgs],
          platform,
        );
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, commandArgs, {
            cwd: root,
            extendEnv: true,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
            forceKillAfter: "5 seconds",
          }),
        );
        return Number(yield* handle.exitCode);
      }),
    ),
  );
});

if (import.meta.main) {
  Effect.gen(function* () {
    const argv = yield* HostProcess.Arguments;
    return yield* runBrowserTestLocal(argv.slice(2));
  }).pipe(
    Effect.catch((message) => Console.error(String(message)).pipe(Effect.as(1))),
    Effect.flatMap((code) =>
      Effect.sync(() => {
        if (code !== 0) process.exitCode = code;
      }),
    ),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}

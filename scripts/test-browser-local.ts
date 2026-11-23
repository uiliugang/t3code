import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { vitePlusCommand } from "./check-changed-command.ts";
import { resolveGitCommonDir, withBrowserTestLock } from "./check-changed-lock.ts";

const USAGE = "Usage: vp run test:browser:local <test files or directories> [vitest options]";

// Vitest flags that unconditionally consume the next argument token when not written as `--flag=value`.
const REQUIRED_VALUE_FLAGS = new Set([
  "-r",
  "--root",
  "-c",
  "--config",
  "-t",
  "--testNamePattern",
  "-p",
  "--project",
  "--dir",
  "--reporter",
  "--outputFile",
  "--mode",
  "--browser",
  "--pool",
  "--execArgv",
  "--vmMemoryLimit",
  "--maxWorkers",
  "--environment",
  "--shard",
  "--sequence",
  "--testTimeout",
  "--hookTimeout",
  "--bail",
  "--retry",
  "--repeats",
  "--diff",
  "--exclude",
  "--slowTestThreshold",
  "--teardownTimeout",
  "--maxConcurrency",
  "--fsModuleCachePath",
  "--attachmentsDir",
  "--configLoader",
  "--tagsFilter",
  "--experimental",
]);

const DOTTED_VALUE_PREFIXES = [
  "--browser.",
  "--outputFile.",
  "--sequence.",
  "--coverage.",
  "--typecheck.",
  "--expect.",
];

// Vitest flags with optional `[value]` arguments that should not turn non-path literals into targets.
const OPTIONAL_VALUE_FLAGS = new Set([
  "-u",
  "--update",
  "--api",
  "--silent",
  "--changed",
  "--inspect",
  "--inspectBrk",
  "--mergeReports",
  "--listTags",
]);

const isOptionalFlagLiteral = (flag: string, next: string): boolean => {
  if (next === "true" || next === "false") return true;
  if ((flag === "-u" || flag === "--update") && /^(?:new|all|none)$/.test(next)) return true;
  if (flag === "--silent" && next === "passed-only") return true;
  if (flag === "--api" && /^\d+$/.test(next)) return true;
  if ((flag === "--inspect" || flag === "--inspectBrk") && /^(?:[\w.-]+:)?\d+$/.test(next)) {
    return true;
  }
  return false;
};

export const parseBrowserTestArgs = (
  rawArgs: ReadonlyArray<string>,
): {
  readonly forwardedArgs: ReadonlyArray<string>;
  readonly help: boolean;
  readonly hasTarget: boolean;
  readonly specifiesFileParallelism: boolean;
} => {
  // `vp run test:browser:local -- <args>` passes a leading `--`; keep a second `--`
  // or a `--` followed by a single dash-prefixed path intact as end-of-options for Vitest.
  const stripsRunnerSeparator =
    rawArgs[0] === "--" &&
    (rawArgs.length <= 1 ||
      rawArgs[1] === "--" ||
      rawArgs[1] === "-h" ||
      rawArgs[1] === "--help" ||
      !rawArgs[1]!.startsWith("-") ||
      REQUIRED_VALUE_FLAGS.has(rawArgs[1]!) ||
      OPTIONAL_VALUE_FLAGS.has(rawArgs[1]!) ||
      DOTTED_VALUE_PREFIXES.some((prefix) => rawArgs[1]!.startsWith(prefix)) ||
      rawArgs[1]!.startsWith("--"));
  const args = stripsRunnerSeparator ? rawArgs.slice(1) : rawArgs;
  let help = false;
  let hasTarget = false;
  let specifiesFileParallelism = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      if (args.slice(index + 1).some((token) => token.length > 0)) {
        hasTarget = true;
      }
      break;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (
      arg === "--fileParallelism" ||
      arg === "--file-parallelism" ||
      arg === "--no-fileParallelism" ||
      arg === "--no-file-parallelism" ||
      arg.startsWith("--fileParallelism=") ||
      arg.startsWith("--file-parallelism=")
    ) {
      specifiesFileParallelism = true;
      continue;
    }
    if (arg.startsWith("-")) {
      if (!arg.includes("=")) {
        if (
          REQUIRED_VALUE_FLAGS.has(arg) ||
          DOTTED_VALUE_PREFIXES.some((prefix) => arg.startsWith(prefix))
        ) {
          index += 1;
          continue;
        }
        const next = args[index + 1];
        if (
          OPTIONAL_VALUE_FLAGS.has(arg) &&
          next !== undefined &&
          !next.startsWith("-") &&
          (arg === "--changed" ||
            arg === "--mergeReports" ||
            arg === "--listTags" ||
            isOptionalFlagLiteral(arg, next))
        ) {
          index += 1;
        }
      }
      continue;
    }
    hasTarget = true;
  }

  return { forwardedArgs: args, help, hasTarget, specifiesFileParallelism };
};

export const runBrowserTestLocal = Effect.fn("testBrowserLocal.run")(function* (
  rawArgs: ReadonlyArray<string>,
  options: { readonly cwd?: string } = {},
) {
  const parsed = parseBrowserTestArgs(rawArgs);
  if (parsed.help) {
    yield* Console.log(USAGE);
    return 0;
  }
  if (!parsed.hasTarget) {
    yield* Console.error(
      `test:browser:local: pass one or more test file or directory paths.\n${USAGE}`,
    );
    return 1;
  }

  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileParallelismEnv = Option.getOrElse(
    yield* Config.option(Config.String("T3_BROWSER_FILE_PARALLELISM")),
    () => "",
  );
  const disableFileParallelism = fileParallelismEnv !== "1" && !parsed.specifiesFileParallelism;
  const root = options.cwd ?? (yield* path.fromFileUrl(new URL("..", import.meta.url)));
  const commonDir = yield* resolveGitCommonDir(root, "test:browser:local");

  return yield* withBrowserTestLock(
    commonDir,
    Effect.scoped(
      Effect.gen(function* () {
        const [command, commandArgs] = vitePlusCommand(
          [
            "test",
            "run",
            ...(disableFileParallelism ? ["--no-file-parallelism"] : []),
            ...parsed.forwardedArgs,
          ],
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

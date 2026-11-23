import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createCLI } from "vite-plus/test/node";

import { vitePlusCommand } from "./check-changed-command.ts";
import { resolveGitCommonDir, withBrowserTestLock } from "./check-changed-lock.ts";

const USAGE = "Usage: vp run test:browser:local <test files or directories> [vitest options]";

export interface ParsedBrowserTestArgs {
  readonly forwardedArgs: ReadonlyArray<string>;
  readonly help: boolean;
  readonly hasTarget: boolean;
  readonly interactive: boolean;
  readonly specifiesFileParallelism: boolean;
}

export const parseBrowserTestArgs = (rawArgs: ReadonlyArray<string>): ParsedBrowserTestArgs => {
  const forwardedArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const cli = createCLI({ allowUnknownOptions: true });
  cli.showHelpOnExit = false;
  cli.showVersionOnExit = false;
  const { args, options } = cli.parse(["node", "/index.js", "run", ...forwardedArgs], {
    run: false,
  });

  return {
    forwardedArgs,
    help: Boolean(options["help"]),
    hasTarget: args.length > 0,
    interactive: Boolean(options["watch"] || options["ui"] || options["standalone"]),
    specifiesFileParallelism: options["fileParallelism"] !== undefined,
  };
};

export const runBrowserTestLocal = Effect.fn("testBrowserLocal.run")(function* (
  rawArgs: ReadonlyArray<string>,
  options: { readonly cwd?: string } = {},
) {
  const parsed = yield* Effect.try({
    try: () => parseBrowserTestArgs(rawArgs),
    catch: (error) =>
      `test:browser:local: ${error instanceof Error ? error.message : String(error)}`,
  });
  if (parsed.help) {
    yield* Console.log(USAGE);
    return 0;
  }
  if (parsed.interactive) {
    yield* Console.error(
      "test:browser:local: interactive watch/UI flags (-w, --watch, --ui, --standalone) cannot be used while holding the repository browser lock.",
    );
    return 1;
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

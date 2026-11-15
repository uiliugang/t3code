import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Console from "effect/Console";
import { Command, Flag } from "effect/cli";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProviderCliShell from "../terminal/ProviderCliShell.ts";
import { baseDirFlag } from "./config.ts";
import { resolveBaseDir, expandHomePath } from "../os-jank.ts";

const operation = (remove: boolean) =>
  Command.make(remove ? "uninstall" : "install", {
    baseDir: baseDirFlag,
    rcFile: Flag.String("rc-file").pipe(
      Flag.optional,
      Flag.withDescription("zsh/bash startup file; defaults to ~/.zshrc on macOS."),
    ),
  }).pipe(
    Command.withDescription(
      remove
        ? "Remove T3 provider command integration from your shell."
        : "Make codex and claude use the T3 default provider in system terminals.",
    ),
    Command.withHandler(
      Effect.fn("terminal.shellIntegration")(function* (flags) {
        const path = yield* Path.Path;
        const env = yield* HostProcess.Environment;
        const home = yield* HostProcess.HomeDirectory;
        const baseDir = yield* resolveBaseDir(
          Option.getOrElse(flags.baseDir, () => env.T3CODE_HOME),
        );
        const defaultRc = env.SHELL?.endsWith("zsh")
          ? path.join(env.T3CODE_ORIGINAL_ZDOTDIR ?? env.ZDOTDIR ?? home, ".zshrc")
          : path.join(
              home,
              (yield* HostProcess.Platform) === "darwin" ? ".bash_profile" : ".bashrc",
            );
        const rcFile = yield* expandHomePath(Option.getOrElse(flags.rcFile, () => defaultRc));
        const integration = yield* ProviderCliShell.ProviderCliShell;
        yield* integration.install(path.join(baseDir, "userdata"), rcFile, remove);
        yield* Console.log(
          `${remove ? "Removed" : "Installed"} T3 provider commands in ${rcFile}. Open a new terminal.`,
        );
      }, Effect.provide(ProviderCliShell.layer)),
    ),
  );

export const terminalCommand = Command.make("terminal").pipe(
  Command.withDescription("Manage codex/claude shell integration (zsh and bash)."),
  Command.withSubcommands([operation(false), operation(true)]),
);

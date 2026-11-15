import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  resolveSelfInvocation,
  selfInvocationArgs,
  type SelfInvocation,
} from "@t3tools/shared/nodeRuntime";

const START = "# >>> T3 provider commands >>>";
const END = "# <<< T3 provider commands <<<";
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

export function renderProviderCommands(stateDir: string, invocation: SelfInvocation) {
  return ["codex", "claude"]
    .map((command) => {
      const argv = [
        invocation.command,
        ...selfInvocationArgs(invocation, ["__provider-cli", stateDir, command]),
      ];
      return `unalias ${command} 2>/dev/null || true\n${command}() { ELECTRON_RUN_AS_NODE=1 ${argv.map(quote).join(" ")} "$@"; }\n`;
    })
    .join("");
}

export function updateShellIntegration(original: string, source: string | null) {
  const start = original.indexOf(START);
  const end = original.indexOf(END);
  if (
    start < 0 !== end < 0 ||
    (start >= 0 && end < start) ||
    original.indexOf(START, start + START.length) >= 0 ||
    original.indexOf(END, end + END.length) >= 0
  )
    throw new Error("Incomplete or duplicate T3 shell integration block.");
  const existingEnd = end + END.length + (original[end + END.length] === "\n" ? 1 : 0);
  const block = source === null ? "" : `${START}\n. ${quote(source)}\n${END}\n`;
  if (start >= 0) return original.slice(0, start) + block + original.slice(existingEnd);
  return source === null
    ? original
    : `${original}${original.length && !original.endsWith("\n") ? "\n" : ""}${block}`;
}

class ShellIntegrationError extends Schema.TaggedError<
  ShellIntegrationError,
  { readonly brand: unique symbol }
>()("ShellIntegrationError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Could not update T3 terminal integration. Check the shell configuration file and its T3 block.";
  }
}

export interface ProviderShellPaths {
  readonly source: string;
  readonly zshDirectory: string;
  readonly bashRc: string;
}
export class ProviderCliShell extends Context.Service<
  ProviderCliShell,
  {
    readonly prepare: (
      stateDir: string,
    ) => Effect.Effect<ProviderShellPaths, ShellIntegrationError>;
    readonly install: (
      stateDir: string,
      rcFile: string,
      remove: boolean,
    ) => Effect.Effect<void, ShellIntegrationError>;
  }
>()("t3/terminal/ProviderCliShell") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const invocation = yield* resolveSelfInvocation();
  const platform = yield* HostProcess.Platform;
  const prepare = Effect.fn("ProviderCliShell.prepare")(
    function* (stateDir: string) {
      const directory = path.join(stateDir, "provider-cli");
      const source = path.join(directory, "env.sh");
      const zshDirectory = path.join(directory, "zsh");
      const bashRc = path.join(directory, "bashrc");
      yield* fs.makeDirectory(zshDirectory, { recursive: true, mode: 0o700 });
      yield* fs.writeFileString(source, renderProviderCommands(stateDir, invocation), {
        mode: 0o600,
      });
      for (const file of [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"]) {
        yield* fs.writeFileString(
          path.join(zshDirectory, file),
          [
            'ZDOTDIR="${T3CODE_ORIGINAL_ZDOTDIR:-$HOME}"',
            `[ ! -f "$ZDOTDIR/${file}" ] || . "$ZDOTDIR/${file}"`,
            'export T3CODE_ORIGINAL_ZDOTDIR="$ZDOTDIR"',
            `export ZDOTDIR=${quote(zshDirectory)}`,
            `. ${quote(source)}`,
            "",
          ].join("\n"),
        );
      }
      yield* fs.writeFileString(
        bashRc,
        [
          ...(platform === "darwin"
            ? [
                'for t3_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do',
                '  if [ -f "$t3_profile" ]; then . "$t3_profile"; break; fi',
                "done",
                "unset t3_profile",
              ]
            : ['[ ! -f "$HOME/.bashrc" ] || . "$HOME/.bashrc"']),
          `. ${quote(source)}`,
          "",
        ].join("\n"),
      );
      return { source, zshDirectory, bashRc };
    },
    Effect.mapError((cause) => new ShellIntegrationError({ cause })),
  );
  const install = Effect.fn("ProviderCliShell.install")(
    function* (stateDir: string, rcFile: string, remove: boolean) {
      const source = remove ? null : (yield* prepare(stateDir)).source;
      const original = yield* fs
        .readFileString(rcFile)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")));
      const updated = yield* Effect.try({
        try: () => updateShellIntegration(original, source),
        catch: (cause) => new ShellIntegrationError({ cause }),
      });
      if (updated !== original) yield* fs.writeFileString(rcFile, updated);
    },
    Effect.mapError((cause) => new ShellIntegrationError({ cause })),
  );
  return ProviderCliShell.of({ prepare, install });
});
export const layer = Layer.effect(ProviderCliShell, make);

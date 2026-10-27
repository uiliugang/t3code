import { VcsProcessSpawnError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import { resolveCommandPath } from "@t3tools/shared/shell";
import type { SourceControlProcessInput } from "@t3tools/source-control-core/server/SourceControlHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const resolveMCodeCommand = Effect.fn("MCodeRuntime.resolve")(
  function* (input: SourceControlProcessInput) {
    if (input.command !== "code-cli") return input;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = { ...(yield* HostProcess.Environment), ...input.env };
    const executable = yield* resolveCommandPath(input.command, { env });
    if (executable === null) return input;
    const resolved = yield* fs.realPath(executable);
    const script = /\.(?:cmd|ps1)$/iu.test(resolved)
      ? path.join(path.dirname(resolved), "node_modules/@ee/code-cli/dist/main.js")
      : resolved;
    const source = yield* fs.readFileString(script).pipe(Effect.orElseSucceed(() => ""));
    if (!/^#![^\r\n]*\bnode(?:\s|$)/u.test(source)) return input;
    // The npm shebang otherwise picks an old shell Node without fetch and reports false offline auth.
    const node = yield* resolveNodeExecutable("Meituan Code", env);
    return {
      ...input,
      command: node,
      args: [script, ...input.args],
      env: { ...input.env, ELECTRON_RUN_AS_NODE: "1" },
    };
  },
  (effect, input) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new VcsProcessSpawnError({
            operation: input.operation,
            command: input.command,
            cwd: input.cwd,
            cause,
          }),
      ),
    ),
);

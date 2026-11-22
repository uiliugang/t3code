import { VcsProcessSpawnError, isRequirementCli } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import { resolveCommandPath, resolveCommandPaths } from "@t3tools/shared/shell";
import type { SourceControlProcessInput } from "@t3tools/source-control-core/server/SourceControlHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeSkillInstallerNode } from "../skills/skillInstallerNode.ts";

export const makeResolveMCodeCommand = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const resolveCliNode = yield* makeSkillInstallerNode;
  return Effect.fn("MCodeRuntime.resolve")(
    function* (input: SourceControlProcessInput) {
      if (input.command !== "code-cli" && !isRequirementCli(input.command)) return input;
      const env = { ...environment, ...input.env };
      if (isRequirementCli(input.command)) {
        const [executable] = yield* resolveCommandPaths(input.command, { env, until: () => true });
        if (!executable) return input;
        const invocation = yield* resolveCliNode(executable, input.args, env);
        return invocation ? { ...input, ...invocation } : input;
      }
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
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
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
});

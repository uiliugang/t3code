import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as ScopedCache from "effect/ScopedCache";
import * as Stream from "effect/Stream";

export const makeSkillInstallerNode = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const aliases = yield* ScopedCache.makeWith<string, string, PlatformError>({
    capacity: 1,
    lookup: Effect.fn("SkillPackages.createNodeAlias")(function* (node: string) {
      const bin = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-node-" });
      yield* fs.writeFileString(
        path.join(bin, "node"),
        `#!/bin/sh\nexec '${node.replaceAll("'", "'\"'\"'")}' "$@"\n`,
        { mode: 0o755 },
      );
      return bin;
    }),
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  });
  return Effect.fn("SkillPackages.resolveInstallerNode")(function* (
    executable: string,
    args: ReadonlyArray<string>,
    environment: NodeJS.ProcessEnv,
  ) {
    const script = yield* fs.realPath(executable);
    const header = yield* fs.stream(script, { bytesToRead: 512 }).pipe(
      Stream.decodeText(),
      Stream.mkString,
      Effect.orElseSucceed(() => ""),
    );
    const shebang = header.split(/[\r\n]/u, 1)[0]?.trimEnd() ?? "";
    const direct = /^#!\s*(?:\S*\/)?(?:node(?:\s+(.+))?|env\s+node)$/u.exec(shebang);
    const envNode = /^#!\s*(?:\S*\/)?env\s+(?:.*\s)?node(?:\s|$)/u.test(shebang);
    if (!direct && !envNode) return;
    const node = yield* resolveNodeExecutable("Skill installation", environment);
    const nodeBin =
      path.basename(node) === "node" ? path.dirname(node) : yield* ScopedCache.get(aliases, node);
    const env: NodeJS.ProcessEnv = {
      ...environment,
      ELECTRON_RUN_AS_NODE: "1",
      PATH: [nodeBin, environment.PATH].filter(Boolean).join(":"),
    };
    if (direct) {
      const option = direct[1];
      const options = !option ? [] : platform === "darwin" ? option.split(/[ \t]+/u) : [option];
      return { node, command: node, args: [...options, script, ...args], env };
    }
    return { node, command: path.resolve(executable), args, env };
  });
});

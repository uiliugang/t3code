import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import { setWindowsPath } from "@t3tools/shared/shell";
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
      if (platform === "win32") {
        const runtimeDir = path.dirname(node);
        // Electron loads ICU and V8 data relative to the image, even in Node mode.
        const sidecars = (yield* fs.readDirectory(runtimeDir)).filter((file) =>
          /\.dll$|^icudtl\.dat$|^(?:v8_context_snapshot|snapshot_blob)\.bin$/iu.test(file),
        );
        for (const file of ["node.exe", ...sidecars]) {
          const from = file === "node.exe" ? node : path.join(runtimeDir, file);
          const to = path.join(bin, file);
          yield* fs.link(from, to).pipe(Effect.catch(() => fs.copyFile(from, to)));
        }
      } else {
        yield* fs.writeFileString(
          path.join(bin, "node"),
          `#!/bin/sh\nexec '${node.replaceAll("'", "'\"'\"'")}' "$@"\n`,
          { mode: 0o755 },
        );
      }
      return bin;
    }),
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  });
  return Effect.fn("SkillPackages.resolveInstallerNode")(function* (
    executable: string,
    args: ReadonlyArray<string>,
    environment: NodeJS.ProcessEnv,
  ) {
    const batch = platform === "win32" && /\.(?:cmd|bat)$/iu.test(executable);
    const script = yield* fs.realPath(executable);
    const header = batch
      ? ""
      : yield* fs.stream(script, { bytesToRead: 512 }).pipe(
          Stream.decodeText(),
          Stream.mkString,
          Effect.orElseSucceed(() => ""),
        );
    const shebang = header.split(/[\r\n]/u, 1)[0]?.trimEnd() ?? "";
    const direct = /^#!\s*(?:\S*\/)?(?:node(?:\s+(.+))?|env\s+node)$/u.exec(shebang);
    const envNode = /^#!\s*(?:\S*\/)?env\s+(?:.*\s)?node(?:\s|$)/u.test(shebang);
    if (!batch && !direct && !envNode) return;
    const resolveNode = resolveNodeExecutable("Skill installation", environment);
    const node = yield* batch ? resolveNode.pipe(Effect.orElseSucceed(() => null)) : resolveNode;
    if (!node) return;
    const nodeBin = /^node(?:\.exe)?$/iu.test(path.basename(node))
      ? path.dirname(node)
      : yield* ScopedCache.get(aliases, node);
    const env: NodeJS.ProcessEnv = { ...environment, ELECTRON_RUN_AS_NODE: "1" };
    const searchPath = [nodeBin, environment.PATH ?? environment.Path ?? environment.path]
      .filter(Boolean)
      .join(platform === "win32" ? ";" : ":");
    if (platform === "win32") setWindowsPath(env, searchPath);
    else env.PATH = searchPath;
    if (direct) {
      const option = direct[1];
      const options = !option ? [] : platform === "darwin" ? option.split(/[ \t]+/u) : [option];
      return { command: node, args: [...options, script, ...args], env };
    }
    return { command: path.resolve(executable), args, env };
  });
});

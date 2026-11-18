import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import { setWindowsPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

export const skillInstallerNode = Effect.fn("SkillPackages.resolveInstallerNode")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const script = yield* fs.realPath(executable);
  const header = yield* fs.stream(script, { bytesToRead: 512 }).pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.orElseSucceed(() => ""),
  );
  if (!/^#![^\r\n]*\bnode(?:\s|$)/u.test(header)) return;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const node = yield* resolveNodeExecutable("Skill installation", environment);
  let nodeBin = path.dirname(node);
  if (!/^node(?:\.exe)?$/iu.test(path.basename(node))) {
    // npm's descendants must also use Electron's Node, not an older shell Node.
    nodeBin = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-node-" });
    const shim = path.join(nodeBin, platform === "win32" ? "node.cmd" : "node");
    yield* fs.writeFileString(
      shim,
      platform === "win32"
        ? `@echo off\r\n"${node.replaceAll("%", "%%")}" %*\r\n`
        : `#!/bin/sh\nexec '${node.replaceAll("'", "'\"'\"'")}' "$@"\n`,
    );
    yield* fs.chmod(shim, 0o755);
  }
  const env: NodeJS.ProcessEnv = { ...environment, ELECTRON_RUN_AS_NODE: "1" };
  const searchPath = `${nodeBin}${platform === "win32" ? ";" : ":"}${environment.PATH ?? environment.Path ?? environment.path ?? ""}`;
  if (platform === "win32") setWindowsPath(env, searchPath);
  else env.PATH = searchPath;
  return { command: node, args: [script, ...args], env };
});

import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveCommandPaths } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const findModernNpm = Effect.fn("meituanNpm.findModernNpm")(function* (
  env: NodeJS.ProcessEnv,
  version: (node: string) => Effect.Effect<string>,
) {
  const platform = yield* HostProcess.Platform;
  if (platform !== "darwin" && platform !== "linux") return null;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const nvmVersions = path.join(env.NVM_DIR || path.join(home, ".nvm"), "versions", "node");
  const versions = yield* fs.readDirectory(nvmVersions).pipe(Effect.orElseSucceed(() => []));
  const nvmBins = versions
    .filter((entry) => /^v\d+\.\d+\.\d+$/u.test(entry))
    .toSorted((left, right) => compareSemverVersions(right.slice(1), left.slice(1)))
    .map((entry) => path.join(nvmVersions, entry, "bin"));
  const npmPaths = yield* resolveCommandPaths("npm", {
    env: { ...env, PATH: [env.PATH, ...nvmBins].filter(Boolean).join(":") },
    until: () => false,
  });
  for (const npm of npmPaths) {
    const bin = path.dirname(npm);
    const [node] = yield* resolveCommandPaths("node", {
      env: { ...env, PATH: bin },
      until: () => true,
    });
    if (!node) continue;
    const nodeVersion = yield* version(node);
    if (nodeMajor(nodeVersion) < 20) continue;
    const script = yield* fs.realPath(npm).pipe(Effect.orElseSucceed(() => null));
    if (script?.endsWith(".js")) {
      return {
        node,
        nodeVersion,
        script,
        env: { PATH: [bin, env.PATH].filter(Boolean).join(":") },
      };
    }
  }
  return null;
});

export const nodeMajor = (version: string) => Number(/^v(\d+)\./u.exec(version)?.[1] ?? 0);

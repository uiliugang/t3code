import * as HostProcess from "@t3tools/shared/HostProcess";
import { isWindowsDrivePath } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// Maps a Windows drive path to the Linux filesystem under standalone WSL.
// WSL mounts Windows drives under a configurable automount root, so only wslpath knows where.
// No WSL env check: servers started by systemd lack WSL_DISTRO_NAME, and off WSL the spawn just fails.
// Untraced: it runs for every chip path, and only drive paths on Linux spawn anything.
export const toHostDrivePath = Effect.fnUntraced(function* (requestedPath: string) {
  const platform = yield* HostProcess.Platform;
  // spawn throws on a NUL byte instead of failing.
  if (!isWindowsDrivePath(requestedPath) || requestedPath.includes("\0")) return requestedPath;
  if (platform !== "linux") return requestedPath;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner
    .string(
      ChildProcess.make("wslpath", ["-u", requestedPath], {
        env: yield* HostProcess.Environment,
        stdin: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.timeout("1 second"),
      Effect.orElseSucceed(() => ""),
    );
  const linuxPath = output.endsWith("\n") ? output.slice(0, -1) : output;
  return linuxPath.startsWith("/") ? linuxPath : requestedPath;
});

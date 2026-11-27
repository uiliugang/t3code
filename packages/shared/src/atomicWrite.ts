import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";

const CHUNK_WRITE_LENGTH = 1 << 20;

// Saves keep the replaced file's mode and create new files owner-only; chmod, since the umask narrows an open mode.
const replacedMode = (fs: FileSystem.FileSystem, targetPath: string) =>
  fs.stat(targetPath).pipe(
    Effect.map((info) => info.mode & 0o777),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(0o600),
    ),
  );

const isUnsupportedSync = (error: PlatformError.PlatformError) => {
  const code = (error.reason.cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "ENOSYS";
};

/** Resolves symlink targets before renaming so writes preserve the link. Iterable contents stream in bounded batches. */
export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string | Iterable<string>;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetPath = yield* resolveSymlinkTarget(input.filePath);
      const targetDirectory = path.dirname(targetPath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      // Cleanup failure must not fail a write that already landed.
      const tempDirectory = yield* Effect.acquireRelease(
        fs.makeTempDirectory({
          directory: targetDirectory,
          prefix: "t3-write-",
        }),
        (directory) => fs.remove(directory, { recursive: true }).pipe(Effect.ignore({ log: true })),
      );
      const tempPath = path.join(tempDirectory, "contents.tmp");

      // One write-only handle: a reopen fails when the umask or the chmod drops access.
      // Without the sync, a crash soon after the rename can leave the target empty.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(tempPath, { flag: "w" });
          const encoder = new TextEncoder();
          const contents = input.contents;
          if (typeof contents === "string") {
            yield* file.writeAll(encoder.encode(contents));
          } else {
            let batch: string[] = [];
            let batchLength = 0;
            for (const chunk of contents) {
              batch.push(chunk);
              batchLength += chunk.length;
              if (batchLength < CHUNK_WRITE_LENGTH) continue;
              yield* file.writeAll(encoder.encode(batch.join("")));
              batch = [];
              batchLength = 0;
            }
            if (batchLength > 0) yield* file.writeAll(encoder.encode(batch.join("")));
          }
          yield* fs.chmod(tempPath, yield* replacedMode(fs, targetPath));
          yield* file.sync;
        }),
      );
      yield* fs.rename(tempPath, targetPath);
      // Persists the rename. A directory without read access cannot be opened to sync, and
      // replacing in one needs only write and search access, so that save stands.
      yield* fs.open(targetDirectory, { flag: "r" }).pipe(
        Effect.flatMap((directory) => directory.sync),
        Effect.scoped,
        Effect.catchIf(
          (error) => error.reason._tag === "PermissionDenied" || isUnsupportedSync(error),
          (error) => Effect.logWarning(error),
        ),
      );
    }),
  );

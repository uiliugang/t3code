import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/**
 * git-annex replaces a linked worktree's `.git` file with a symlink to its admin
 * directory, so its symlinks into `.git/annex` resolve. Git then refuses to remove it.
 */
const annexedAdminDir = Effect.fn("WorktreeRemoval.annexedAdminDir")(
  function* (worktreePath: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const adminDir = path.resolve(
      worktreePath,
      yield* fileSystem.readLink(path.join(worktreePath, ".git")),
    );
    const pointsBackTo = path.dirname(
      path.resolve(
        adminDir,
        (yield* fileSystem.readFileString(path.join(adminDir, "gitdir"))).trim(),
      ),
    );
    return (yield* fileSystem.realPath(pointsBackTo)) === (yield* fileSystem.realPath(worktreePath))
      ? Option.some(adminDir)
      : Option.none();
  },
  Effect.orElseSucceed(() => Option.none<string>()),
);

export const isLinkedWorktree = Effect.fn("WorktreeRemoval.isLinkedWorktree")(function* (
  worktreePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return (
    (yield* fileSystem.stat(path.join(worktreePath, ".git"))).type === "File" ||
    Option.isSome(yield* annexedAdminDir(worktreePath))
  );
});

export const removeLinkedWorktree = Effect.fn("WorktreeRemoval.removeLinkedWorktree")(function* <
  A,
  E,
  R,
>(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly worktreePath: string;
  readonly force: boolean;
  readonly run: (args: ReadonlyArray<string>) => Effect.Effect<A, E, R>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const worktreePath = input.worktreePath;
  const gitFile = path.join(worktreePath, ".git");
  // Git refuses to remove a worktree with untracked files unless forced, but
  // its check honors `status.showUntrackedFiles=no` and would delete them.
  const statusConfig = ["-c", "status.showUntrackedFiles=normal"];
  // Git's own refusals, worded the way it prints them.
  const refuse = (message: string, cause?: unknown) =>
    new GitCommandError({
      operation: input.operation,
      command: "git worktree remove",
      cwd: input.cwd,
      detail: `fatal: ${message}`,
      ...(cause === undefined ? {} : { cause }),
    });
  const annexed = yield* annexedAdminDir(worktreePath);
  if (Option.isSome(annexed)) {
    const adminDir = annexed.value;
    const writeGitFile = fileSystem.writeFileString(gitFile, `gitdir: ${adminDir}\n`);
    // A kept worktree's annexed files resolve only through the symlink; a gitdir
    // file is the fallback when it cannot be recreated.
    yield* Effect.addFinalizer(() =>
      fileSystem.exists(worktreePath).pipe(
        Effect.flatMap((kept) =>
          kept
            ? fileSystem.remove(gitFile, { force: true }).pipe(
                Effect.andThen(fileSystem.symlink(adminDir, gitFile)),
                Effect.catch(() => writeGitFile),
              )
            : Effect.void,
        ),
        Effect.ignore,
      ),
    );
    yield* fileSystem.remove(gitFile).pipe(
      Effect.andThen(writeGitFile),
      Effect.mapError((cause) => refuse(`failed to replace '${gitFile}'`, cause)),
    );
  }
  return yield* input.run([
    ...statusConfig,
    "worktree",
    "remove",
    ...(input.force ? ["--force"] : []),
    "--",
    worktreePath,
  ]);
}, Effect.scoped);

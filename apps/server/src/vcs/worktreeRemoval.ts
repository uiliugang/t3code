import { GitCommandError } from "@t3tools/contracts";
import { tryUnquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type * as GitVcsDriver from "./GitVcsDriver.ts";
import { removeEmptyDirectory } from "./removeEmptyDirectory.ts";

// Git's own removal and the checks that mirror it share one bound.
export const WORKTREE_REMOVE_TIMEOUT_MS = 5 * 60_000;

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

export const hasWorktreeSubmoduleFiles = Effect.fn("WorktreeRemoval.hasSubmoduleFiles")(function* ({
  adminDir,
  execute,
  ...command
}: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "env" | "timeoutMs"> & {
  readonly adminDir: string;
  readonly execute: GitVcsDriver.GitVcsDriver["Service"]["execute"];
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (
    yield* fileSystem.exists(path.join(adminDir, "modules")).pipe(Effect.orElseSucceed(() => true))
  ) {
    return true;
  }
  let protectedFiles = false;
  yield* execute({
    ...command,
    args: ["-c", "core.quotePath=true", "ls-files", "--stage"],
    maxOutputBytes: 64 * 1024,
    appendTruncationMarker: true,
    keepLineCallbacksAfterTruncation: true,
    progress: {
      onStdoutLine: (line) => {
        if (protectedFiles || !line.startsWith("160000 ")) return Effect.void;
        const relative = tryUnquoteGitPatchPath(line.slice(line.indexOf("\t") + 1));
        if (relative === null) {
          return Effect.sync(() => {
            protectedFiles = true;
          });
        }
        const directory = path.resolve(command.cwd, relative);
        // Git status omits local files inside uninitialized gitlinks.
        return fileSystem.realPath(directory).pipe(
          Effect.flatMap((real) =>
            real !== directory
              ? Effect.succeed(true)
              : fileSystem.readDirectory(real).pipe(Effect.map((names) => names.length > 0)),
          ),
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeed(false),
          ),
          Effect.orElseSucceed(() => true),
          Effect.tap((present) =>
            Effect.sync(() => {
              protectedFiles = present;
            }),
          ),
          Effect.asVoid,
        );
      },
    },
  });
  return protectedFiles;
});

/**
 * Git can drop a worktree's registration even if it fails to delete the checkout.
 * Mirror Git's removal checks, delete the checkout first, then let Git unregister it.
 */
export const removeLinkedWorktree = Effect.fn("WorktreeRemoval.removeLinkedWorktree")(function* <
  A,
  E,
  R,
>(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly worktreePath: string;
  readonly repositoryGitDir?: string;
  readonly force: boolean;
  readonly stopWorktreeIndexRefresh: GitVcsDriver.GitVcsDriver["Service"]["stopWorktreeIndexRefresh"];
  readonly execute: GitVcsDriver.GitVcsDriver["Service"]["execute"];
  readonly run: (args: ReadonlyArray<string>, cwd: string) => Effect.Effect<A, E, R>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Deleting through a symlink would only unlink the alias and leave the checkout.
  const worktreePath = yield* fileSystem
    .realPath(input.worktreePath)
    .pipe(Effect.orElseSucceed(() => input.worktreePath));
  const gitFile = path.join(worktreePath, ".git");
  // Git refuses to remove a worktree with untracked files unless forced, but
  // its check honors `status.showUntrackedFiles=no` and would delete them.
  const statusConfig = ["-c", "status.showUntrackedFiles=normal"];
  const repositoryArgs = input.repositoryGitDir ? [`--git-dir=${input.repositoryGitDir}`] : [];
  // Git's own refusals, worded the way it prints them.
  const refuse = (message: string, cause?: unknown) =>
    new GitCommandError({
      operation: input.operation,
      command: "git worktree remove",
      cwd: input.cwd,
      detail: `fatal: ${message}`,
      ...(cause === undefined ? {} : { cause }),
    });
  yield* input.stopWorktreeIndexRefresh(worktreePath);
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
  const linked = yield* fileSystem.stat(gitFile).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.orElseSucceed(() => false),
  );
  if (!linked) {
    return yield* input.run(
      [
        ...repositoryArgs,
        ...statusConfig,
        "worktree",
        "remove",
        ...(input.force ? ["--force"] : []),
        "--",
        worktreePath,
      ],
      input.cwd,
    );
  }

  const gitOutput = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    input
      .execute({
        operation: input.operation,
        cwd,
        args,
        maxOutputBytes: 64 * 1024 * 1024,
        timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
        ...(env === undefined ? {} : { env }),
      })
      .pipe(Effect.map((result) => result.stdout));
  // Compare filesystem identity rather than folding case on case-sensitive filesystems.
  const samePath = (left: string, right: string) =>
    Effect.all([fileSystem.stat(left), fileSystem.stat(right)]).pipe(
      Effect.map(
        ([a, b]) =>
          a.dev === b.dev && Option.isSome(a.ino) && a.ino.value === Option.getOrUndefined(b.ino),
      ),
      Effect.orElseSucceed(() => false),
    );

  // A registered worktree of this repository: its `.git` file names an admin
  // directory under the common `worktrees/`, whose `gitdir` points back.
  const notAWorktree = refuse(`'${worktreePath}' is not a working tree`);
  const adminDir = path.resolve(
    worktreePath,
    (yield* gitOutput(worktreePath, ["rev-parse", "--absolute-git-dir"]).pipe(
      Effect.mapError(() => notAWorktree),
    )).replace(/\n$/, ""),
  );
  const commonDir = path.resolve(
    input.cwd,
    (yield* gitOutput(input.cwd, [...repositoryArgs, "rev-parse", "--git-common-dir"])).replace(
      /\n$/,
      "",
    ),
  );
  const pointsBack = yield* fileSystem.readFileString(path.join(adminDir, "gitdir")).pipe(
    // Folders, not `.git` files: a hard-linked copy of the checkout shares its `.git` file.
    Effect.flatMap((gitdir) => {
      const backlink = path.resolve(adminDir, gitdir.trim());
      return path.basename(backlink) === ".git"
        ? samePath(path.dirname(backlink), worktreePath)
        : Effect.succeed(false);
    }),
    Effect.orElseSucceed(() => false),
  );
  if (!pointsBack || !(yield* samePath(path.dirname(adminDir), path.join(commonDir, "worktrees"))))
    return yield* notAWorktree;
  // Git counts the file's existence as a lock. T3 passes at most one
  // `--force`, which never removes a locked worktree. Anything but a
  // confirmed absence refuses.
  const lockFile = path.join(adminDir, "locked");
  const locked = yield* fileSystem.stat(lockFile).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed(false)
        : Effect.fail(refuse(`cannot inspect the lock of '${worktreePath}'`, error)),
    ),
  );
  if (locked) {
    const reason = (yield* fileSystem.readFileString(lockFile).pipe(Effect.option)).pipe(
      Option.map((text) => text.trim()),
      Option.getOrElse(() => ""),
    );
    return yield* refuse(
      reason === ""
        ? "cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first"
        : `cannot remove a locked working tree, lock reason: ${reason}\nuse 'remove -f -f' to override or unlock first`,
    );
  }
  if (!input.force) {
    // Bound like Git's own check, so `core.worktree` can't point it elsewhere.
    const boundEnv = { GIT_DIR: gitFile, GIT_WORK_TREE: worktreePath };
    if (
      yield* hasWorktreeSubmoduleFiles({
        operation: input.operation,
        cwd: worktreePath,
        adminDir,
        execute: input.execute,
        env: boundEnv,
        timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
      })
    ) {
      return yield* refuse("working trees containing submodules cannot be moved or removed");
    }
    const status = yield* gitOutput(
      worktreePath,
      [...statusConfig, "status", "--porcelain", "--ignore-submodules=none"],
      boundEnv,
    );
    if (status !== "")
      return yield* refuse(
        `'${worktreePath}' contains modified or untracked files, use --force to delete it`,
      );
  }

  // A file held open can stop the delete partway, so `.git` goes last and a retry still
  // finds the worktree. Node's recursive `rm` reports the first error while sibling
  // deletes still run, so `.git` must not be among them.
  const gitFileContents = yield* fileSystem
    .readFileString(gitFile)
    .pipe(Effect.mapError(() => notAWorktree));
  const failedToDelete = (cause: unknown) => refuse(`failed to delete '${worktreePath}'`, cause);
  for (const name of yield* fileSystem
    .readDirectory(worktreePath)
    .pipe(Effect.mapError(failedToDelete))) {
    if (name === ".git") continue;
    yield* fileSystem
      .remove(path.join(worktreePath, name), { recursive: true })
      .pipe(Effect.mapError(failedToDelete));
  }
  yield* fileSystem.remove(gitFile).pipe(
    Effect.mapError(failedToDelete),
    Effect.andThen(
      removeEmptyDirectory(worktreePath).pipe(
        Effect.mapError(failedToDelete),
        Effect.filterOrFail(
          (removed) => removed,
          () => refuse(`new files appeared in '${worktreePath}' during removal`),
        ),
        Effect.tapError(() =>
          fileSystem.writeFileString(gitFile, gitFileContents, { flag: "wx" }).pipe(Effect.ignore),
        ),
      ),
    ),
    Effect.uninterruptible,
  );
  // The folder is gone, so Git only drops the worktree's metadata. The caller's `cwd` may
  // have been inside it; the common Git directory survives, and is named explicitly
  // because `safe.bareRepository=explicit` refuses to discover it.
  return yield* input.run(
    [
      `--git-dir=${commonDir}`,
      "worktree",
      "remove",
      ...(input.force ? ["--force"] : []),
      "--",
      worktreePath,
    ],
    commonDir,
  );
}, Effect.scoped);

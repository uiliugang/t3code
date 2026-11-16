import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const CARRY_DIFF_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const CARRY_DIFF_TIMEOUT_MS = 2 * 60_000;
const COPY_CONCURRENCY = 16;

export interface CarriedCheckoutChanges {
  readonly sourceCheckoutRoot: string;
  readonly stagedPatch: string;
  readonly unstagedPatch: string;
  readonly untrackedPaths: ReadonlyArray<string>;
}

const carryError = (cwd: string, command: string, detail: string, cause?: unknown) =>
  new GitCommandError({
    operation: "carryCheckoutChanges",
    command,
    cwd,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const readGitStdout = Effect.fn("carryCheckoutChanges.readGitStdout")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const result = yield* git.execute({
    operation: "carryCheckoutChanges.read",
    cwd,
    args,
    timeoutMs: CARRY_DIFF_TIMEOUT_MS,
    maxOutputBytes: CARRY_DIFF_MAX_OUTPUT_BYTES,
  });
  if (result.stdoutTruncated) {
    return yield* carryError(
      cwd,
      `git ${args[0] ?? "diff"}`,
      "Uncommitted changes are too large to carry into a new worktree.",
    );
  }
  return result.stdout;
});

const assertNoSymlinkParent = Effect.fn("carryCheckoutChanges.assertNoSymlinkParent")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  worktreeRoot: string,
  relativePath: string,
) {
  let current = worktreeRoot;
  for (const segment of path
    .dirname(relativePath)
    .split(/[\\/]/)
    .filter((part) => part.length > 0 && part !== ".")) {
    current = path.join(current, segment);
    if (Option.isSome(yield* fs.readLink(current).pipe(Effect.option))) {
      return yield* carryError(
        worktreeRoot,
        "copy untracked file",
        `Refused to write through symbolic link parent: ${relativePath}`,
      );
    }
    const info = yield* fs.stat(current).pipe(Effect.orElseSucceed(() => null));
    if (info === null) return;
  }
});

/** Reads uncommitted staged, unstaged, and untracked changes against `commit` without mutating `sourceCwd`. */
export const readCarriedCheckoutChanges = Effect.fn("readCarriedCheckoutChanges")(
  function* (input: {
    readonly git: GitVcsDriver.GitVcsDriver["Service"];
    readonly fs: FileSystem.FileSystem;
    readonly sourceCwd: string;
    readonly commit: string;
  }): Effect.fn.Return<CarriedCheckoutChanges, GitCommandError> {
    const { git, fs, commit } = input;
    const toplevel = (yield* git.execute({
      operation: "carryCheckoutChanges.toplevel",
      cwd: input.sourceCwd,
      args: ["rev-parse", "--show-toplevel"],
    })).stdout.replace(/\r?\n$/, "");
    const sourceCheckoutRoot = yield* fs
      .realPath(toplevel)
      .pipe(
        Effect.mapError((cause) =>
          carryError(input.sourceCwd, "realpath", "Could not resolve source checkout root.", cause),
        ),
      );
    const diffPrefix = ["--no-color", "--no-ext-diff", "--no-textconv", "--binary"] as const;
    const stagedPatch = yield* readGitStdout(git, sourceCheckoutRoot, [
      "diff",
      "--cached",
      ...diffPrefix,
      commit,
    ]);
    const unstagedPatch = yield* readGitStdout(git, sourceCheckoutRoot, ["diff", ...diffPrefix]);
    const untrackedRaw = yield* readGitStdout(git, sourceCheckoutRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const untrackedPaths = untrackedRaw
      .split("\0")
      .filter((entry) => entry.length > 0 && !entry.endsWith("/"));
    return {
      sourceCheckoutRoot,
      stagedPatch,
      unstagedPatch,
      untrackedPaths,
    };
  },
);

/** Applies previously captured staged/unstaged patches and copies untracked files into `targetCheckoutRoot`. */
export const applyCarriedCheckoutChanges = Effect.fn("applyCarriedCheckoutChanges")(
  function* (input: {
    readonly git: GitVcsDriver.GitVcsDriver["Service"];
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly targetCheckoutRoot: string;
    readonly changes: CarriedCheckoutChanges;
  }): Effect.fn.Return<void, GitCommandError> {
    const { git, fs, path, targetCheckoutRoot, changes } = input;
    if (changes.stagedPatch.length > 0) {
      yield* git.execute({
        operation: "carryCheckoutChanges.applyStaged",
        cwd: targetCheckoutRoot,
        args: ["apply", "--index", "--binary", "-"],
        stdin: changes.stagedPatch,
        timeoutMs: CARRY_DIFF_TIMEOUT_MS,
      });
    }
    if (changes.unstagedPatch.length > 0) {
      yield* git.execute({
        operation: "carryCheckoutChanges.applyUnstaged",
        cwd: targetCheckoutRoot,
        args: ["apply", "--binary", "-"],
        stdin: changes.unstagedPatch,
        timeoutMs: CARRY_DIFF_TIMEOUT_MS,
      });
    }
    yield* Effect.forEach(
      changes.untrackedPaths,
      (relativePath) =>
        Effect.gen(function* () {
          const from = path.join(changes.sourceCheckoutRoot, relativePath);
          if (Option.isSome(yield* fs.readLink(from).pipe(Effect.option))) return;
          const info = yield* fs.stat(from).pipe(Effect.orElseSucceed(() => null));
          if (info === null || info.type !== "File") return;
          yield* assertNoSymlinkParent(fs, path, targetCheckoutRoot, relativePath);
          const destination = path.join(targetCheckoutRoot, relativePath);
          if (yield* fs.exists(destination).pipe(Effect.orElseSucceed(() => false))) return;
          yield* fs.makeDirectory(path.dirname(destination), { recursive: true }).pipe(
            Effect.andThen(fs.copyFile(from, destination)),
            Effect.mapError((cause) =>
              carryError(
                targetCheckoutRoot,
                "copy untracked file",
                `Failed to copy untracked file ${relativePath}.`,
                cause,
              ),
            ),
          );
        }),
      { concurrency: COPY_CONCURRENCY, discard: true },
    );
  },
);

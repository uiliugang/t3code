import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  PATCH_RENDER_PREFIX_ARGS,
  splitNullSeparatedGitStdoutPaths,
} from "../vcs/GitVcsDriverCore.ts";

const CARRY_DIFF_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const CARRY_DIFF_TIMEOUT_MS = 2 * 60_000;
const CARRY_UNTRACKED_MAX_FILES = 5_000;
const CARRY_UNTRACKED_MAX_BYTES = 256 * 1024 * 1024;
const COPY_CONCURRENCY = 16;

export interface CarriedCheckoutChanges {
  readonly sourceCheckoutRoot: string;
  readonly stagedPatchPath: string | null;
  readonly unstagedPatchPath: string | null;
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

const CARRY_DIFF_BASE_ARGS = [
  "-c",
  "diff.suppressBlankEmpty=false",
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--submodule=short",
  "--binary",
  ...PATCH_RENDER_PREFIX_ARGS,
] as const;

const writeDiffPatchFile = Effect.fn("carryCheckoutChanges.writeDiffPatchFile")(function* (input: {
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly fs: FileSystem.FileSystem;
  readonly cwd: string;
  readonly extraArgs: ReadonlyArray<string>;
}): Effect.fn.Return<string | null, GitCommandError, Scope.Scope> {
  const { git, fs, cwd, extraArgs } = input;
  const patchPath = yield* fs
    .makeTempFileScoped({ prefix: "t3-carry-patch-", suffix: ".patch" })
    .pipe(
      Effect.mapError((cause) =>
        carryError(cwd, "git diff", "Could not allocate temporary patch file.", cause),
      ),
    );
  yield* git.execute({
    operation: "carryCheckoutChanges.diff",
    cwd,
    args: [...CARRY_DIFF_BASE_ARGS, `--output=${patchPath}`, ...extraArgs],
    timeoutMs: CARRY_DIFF_TIMEOUT_MS,
  });
  const info = yield* fs
    .stat(patchPath)
    .pipe(
      Effect.mapError((cause) =>
        carryError(cwd, "git diff", "Could not inspect temporary patch file.", cause),
      ),
    );
  const size = Number(info.size);
  if (size === 0) return null;
  if (size > CARRY_DIFF_MAX_OUTPUT_BYTES) {
    return yield* carryError(
      cwd,
      "git diff",
      "Uncommitted changes are too large to carry into a new worktree.",
    );
  }
  return patchPath;
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
  }): Effect.fn.Return<CarriedCheckoutChanges, GitCommandError, Scope.Scope> {
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
    const unmerged = yield* git.execute({
      operation: "carryCheckoutChanges.unmerged",
      cwd: sourceCheckoutRoot,
      args: ["ls-files", "--unmerged", "-z"],
      timeoutMs: CARRY_DIFF_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      appendTruncationMarker: true,
    });
    if (unmerged.stdout.length > 0) {
      return yield* carryError(
        sourceCheckoutRoot,
        "git ls-files --unmerged",
        "Resolve merge conflicts in the current checkout before forking into a new worktree.",
      );
    }
    const stagedPatchPath = yield* writeDiffPatchFile({
      git,
      fs,
      cwd: sourceCheckoutRoot,
      extraArgs: ["--cached", commit],
    });
    const unstagedPatchPath = yield* writeDiffPatchFile({
      git,
      fs,
      cwd: sourceCheckoutRoot,
      extraArgs: [],
    });
    const untrackedResult = yield* git.execute({
      operation: "carryCheckoutChanges.untracked",
      cwd: sourceCheckoutRoot,
      args: ["ls-files", "--others", "--exclude-standard", "-z"],
      timeoutMs: CARRY_DIFF_TIMEOUT_MS,
      maxOutputBytes: CARRY_DIFF_MAX_OUTPUT_BYTES,
      appendTruncationMarker: true,
    });
    if (untrackedResult.stdoutTruncated) {
      return yield* carryError(
        sourceCheckoutRoot,
        "git ls-files",
        "Untracked file list is too large to carry into a new worktree.",
      );
    }
    const untrackedPaths = splitNullSeparatedGitStdoutPaths(untrackedResult).filter(
      (entry) => !entry.endsWith("/"),
    );
    if (untrackedPaths.length > CARRY_UNTRACKED_MAX_FILES) {
      return yield* carryError(
        sourceCheckoutRoot,
        "git ls-files",
        `Too many untracked files (${untrackedPaths.length}) to carry into a new worktree.`,
      );
    }
    return {
      sourceCheckoutRoot,
      stagedPatchPath,
      unstagedPatchPath,
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
    if (changes.stagedPatchPath !== null) {
      yield* git.execute({
        operation: "carryCheckoutChanges.applyStaged",
        cwd: targetCheckoutRoot,
        args: ["apply", "--index", "--binary", "--whitespace=nowarn", changes.stagedPatchPath],
        timeoutMs: CARRY_DIFF_TIMEOUT_MS,
      });
    }
    if (changes.unstagedPatchPath !== null) {
      yield* git.execute({
        operation: "carryCheckoutChanges.applyUnstaged",
        cwd: targetCheckoutRoot,
        args: ["apply", "--binary", "--whitespace=nowarn", changes.unstagedPatchPath],
        timeoutMs: CARRY_DIFF_TIMEOUT_MS,
      });
    }
    let copiedUntrackedBytes = 0;
    for (const relativePath of changes.untrackedPaths) {
      const linkOption = yield* fs
        .readLink(path.join(changes.sourceCheckoutRoot, relativePath))
        .pipe(Effect.option);
      if (Option.isSome(linkOption)) {
        const linkTarget = linkOption.value;
        const resolvedLinkTarget = path.resolve(
          targetCheckoutRoot,
          path.dirname(relativePath),
          linkTarget,
        );
        const relToRoot = path.relative(targetCheckoutRoot, resolvedLinkTarget);
        if (
          path.isAbsolute(linkTarget) ||
          relToRoot === ".." ||
          relToRoot.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relToRoot)
        ) {
          return yield* carryError(
            targetCheckoutRoot,
            "copy untracked symlink",
            `Refused to carry untracked symbolic link pointing outside checkout: ${relativePath}`,
          );
        }
        continue;
      }
      const from = path.join(changes.sourceCheckoutRoot, relativePath);
      const info = yield* fs.stat(from).pipe(Effect.orElseSucceed(() => null));
      if (info !== null && info.type === "File") {
        copiedUntrackedBytes += Number(info.size);
        if (copiedUntrackedBytes > CARRY_UNTRACKED_MAX_BYTES) {
          return yield* carryError(
            targetCheckoutRoot,
            "copy untracked file",
            "Untracked files exceed 256 MiB and cannot be carried into a new worktree.",
          );
        }
      }
    }
    yield* Effect.forEach(
      changes.untrackedPaths,
      (relativePath) =>
        Effect.gen(function* () {
          const from = path.join(changes.sourceCheckoutRoot, relativePath);
          const linkOption = yield* fs.readLink(from).pipe(Effect.option);
          yield* assertNoSymlinkParent(fs, path, targetCheckoutRoot, relativePath);
          const destination = path.join(targetCheckoutRoot, relativePath);
          if (Option.isSome(yield* fs.readLink(destination).pipe(Effect.option))) {
            return yield* carryError(
              targetCheckoutRoot,
              "copy untracked file",
              `Refused to overwrite symbolic link destination: ${relativePath}`,
            );
          }
          if (yield* fs.exists(destination).pipe(Effect.orElseSucceed(() => false))) return;
          if (Option.isSome(linkOption)) {
            yield* fs.makeDirectory(path.dirname(destination), { recursive: true }).pipe(
              Effect.andThen(fs.symlink(linkOption.value, destination)),
              Effect.mapError((cause) =>
                carryError(
                  targetCheckoutRoot,
                  "copy untracked symlink",
                  `Failed to recreate untracked symbolic link ${relativePath}.`,
                  cause,
                ),
              ),
            );
            return;
          }
          const info = yield* fs.stat(from).pipe(Effect.orElseSucceed(() => null));
          if (info === null || info.type !== "File") return;
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

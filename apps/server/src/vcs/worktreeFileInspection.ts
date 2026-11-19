import type { WorkspaceCheckoutIdentity, WorktreeCleanupRules } from "@t3tools/contracts";
import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const errorCode = (error: PlatformError) =>
  error.cause instanceof Error && "code" in error.cause ? error.cause.code : undefined;

export const makeWorktreeFileInspection = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;

  // Git status and non-forced worktree removal both skip assume-unchanged and skip-worktree files.
  const hiddenTrackedChange = Effect.fn("StorageCleanup.hiddenTrackedChange")(function* (
    cwd: string,
  ) {
    const inspect = (args: string[], stdin?: string) =>
      git.execute({
        operation: "StorageCleanup.hiddenTrackedChanges",
        cwd,
        args,
        ...(stdin === undefined ? {} : { stdin }),
        maxOutputBytes: 1024 * 1024,
      });
    const sparse = yield* inspect([
      "config",
      "--type=bool",
      "--default=false",
      "core.sparseCheckout",
    ]);
    // Sparse checkouts flag every file outside the cone; Git 2.37+ unflags those it finds on disk.
    const hiddenTag = sparse.stdout.trim() === "true" ? /^[a-z]$/ : /^(?:S|[a-z])$/;
    const flagged: Array<{ readonly mode: string; readonly id: string; readonly file: string }> =
      [];
    let overflow = false;
    yield* git.execute({
      operation: "StorageCleanup.hiddenTrackedChanges",
      cwd,
      args: ["-c", "core.quotePath=false", "ls-files", "-s", "-v"],
      maxOutputBytes: 64 * 1024,
      appendTruncationMarker: true,
      keepLineCallbacksAfterTruncation: true,
      progress: {
        onStdoutLine: (line) =>
          Effect.sync(() => {
            const match = /^(\S) (\d+) ([0-9a-f]+) \d\t(.*)$/s.exec(line);
            if (match === null || !hiddenTag.test(match[1]!) || match[2] === "160000") return;
            if (flagged.length < 10_000)
              flagged.push({ mode: match[2]!, id: match[3]!, file: match[4]! });
            else overflow = true;
          }),
      },
    });
    if (overflow) return "hidden tracked files exceed the inspection limit";
    const reason = (file: string) => `has uncommitted changes hidden from git status (${file})`;
    // Quoted names (control characters, quotes, backslashes) and names that are not valid UTF-8
    // decode to text that is not the path on disk.
    const unreadable = flagged.find(({ file }) => file.startsWith('"') || file.includes("\uFFFD"));
    if (unreadable !== undefined) return reason(unreadable.file);
    const onDisk = yield* Effect.forEach(
      flagged,
      (entry) => {
        const file = path.join(cwd, entry.file);
        return fs.readLink(file).pipe(
          Effect.map((target) => ({ ...entry, type: "SymbolicLink", target })),
          Effect.catchIf(
            (error) => errorCode(error) === "EINVAL",
            () => fs.stat(file).pipe(Effect.map((info) => ({ ...entry, type: info.type }))),
          ),
          Effect.catchIf(
            (error) => errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR",
            () => Effect.succeed(null),
          ),
        );
      },
      { concurrency: 16 },
    );
    const files: Array<{ readonly id: string; readonly file: string }> = [];
    // Without core.symlinks a tracked link is a regular file holding its target, compared unfiltered.
    const linkFiles: typeof files = [];
    for (const entry of onDisk) {
      if (entry === null) continue;
      if (entry.type === "File") (entry.mode === "120000" ? linkFiles : files).push(entry);
      else if (!("target" in entry) || entry.mode !== "120000") return reason(entry.file);
      // Hashing a link's path would hash the file it points to.
      else if (
        (yield* inspect(["hash-object", "--stdin"], entry.target)).stdout.trim() !== entry.id
      )
        return reason(entry.file);
    }
    const hashPaths = (entries: ReadonlyArray<{ readonly file: string }>, flags: string[]) =>
      entries.length === 0
        ? Effect.succeed([])
        : inspect(
            ["hash-object", ...flags, "--stdin-paths"],
            entries.map(({ file }) => `${file}\n`).join(""),
          ).pipe(Effect.map((result) => result.stdout.split("\n")));
    const worktreeIds = yield* hashPaths(files, []);
    const linkIds = yield* hashPaths(linkFiles, ["--no-filters"]);
    const changed =
      files.find(({ id }, i) => worktreeIds[i] !== id) ??
      linkFiles.find(({ id }, i) => linkIds[i] !== id);
    return changed === undefined ? null : reason(changed.file);
  });

  const localChangesReason = Effect.fn("StorageCleanup.localChangesReason")(function* (
    cwd: string,
    rules: Pick<WorktreeCleanupRules, "worktreeKeepWhen">,
  ) {
    const status = yield* git.execute({
      operation: "StorageCleanup.localChanges",
      cwd,
      args: [
        "status",
        "--porcelain=v1",
        "-z",
        "--ignore-submodules=none",
        rules.worktreeKeepWhen === "tracked-changes"
          ? "--untracked-files=no"
          : "--untracked-files=all",
      ],
      maxOutputBytes: 64 * 1024,
      appendTruncationMarker: true,
    });
    if (status.stdoutTruncated) return "local changes exceed the inspection limit";
    const records = status.stdout.split("\0").filter(Boolean);
    let count = 0;
    for (let i = 0; i < records.length; i++) {
      count++;
      if (/^[RC]|^.[RC]/.test(records[i]!)) i++;
    }
    if (count > 0) return `has uncommitted changes (${count} ${count === 1 ? "file" : "files"})`;
    const hidden = yield* hiddenTrackedChange(cwd);
    if (hidden !== null) return hidden;
    if (rules.worktreeKeepWhen !== "any-local-files") return null;
    const ignored = yield* git.execute({
      operation: "StorageCleanup.ignoredFiles",
      cwd,
      args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      maxOutputBytes: 64 * 1024,
      appendTruncationMarker: true,
    });
    if (ignored.stdoutTruncated) return "ignored files exceed the inspection limit";
    const file = ignored.stdout
      .split("\0")
      .find((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry));
    return file === undefined ? null : `has ignored files (${file})`;
  });

  const hasSubmoduleFiles = Effect.fn("ManagedWorktrees.hasSubmoduleFiles")(function* (
    identity: WorkspaceCheckoutIdentity,
  ) {
    let protectedFiles = yield* fs.exists(path.join(identity.gitDir, "modules"));
    yield* git.execute({
      operation: "ManagedWorktrees.submodules",
      cwd: identity.checkoutRoot,
      args: ["ls-files", "--stage"],
      maxOutputBytes: 64 * 1024,
      appendTruncationMarker: true,
      keepLineCallbacksAfterTruncation: true,
      progress: {
        onStdoutLine: (line) => {
          if (protectedFiles || !line.startsWith("160000 ")) return Effect.void;
          const relative = unquoteGitPatchPath(line.slice(line.indexOf("\t") + 1));
          const directory = path.resolve(identity.checkoutRoot, relative);
          // Uninitialized gitlinks may be empty; status omits local files placed inside them.
          return fs.realPath(directory).pipe(
            Effect.flatMap((real) =>
              real !== directory || relative.includes("\uFFFD")
                ? Effect.succeed(true)
                : fs.readDirectory(real).pipe(Effect.map((names) => names.length > 0)),
            ),
            Effect.catchIf(
              (error) => error.reason._tag === "NotFound",
              () => Effect.succeed(relative.includes("\uFFFD")),
            ),
            Effect.orElseSucceed(() => true),
            Effect.tap((present) =>
              Effect.sync(() => {
                if (present) protectedFiles = true;
              }),
            ),
            Effect.asVoid,
          );
        },
      },
    });
    return protectedFiles;
  });

  return { localChangesReason, hasSubmoduleFiles };
});

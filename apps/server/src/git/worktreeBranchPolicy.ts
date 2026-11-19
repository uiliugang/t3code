import type { OrchestrationV2ThreadShell, ServerSettings, ThreadId } from "@t3tools/contracts";
import { isMainOrMasterBranch } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import type { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { parseRemoteNames, parseRemoteRefWithRemoteNames } from "./remoteRefs.ts";

type WorktreeOrigin = Partial<
  Pick<OrchestrationV2ThreadShell, "lineage" | "delegatedFrom" | "forkedFrom">
>;

export const isChildWorktree = Effect.fn("worktreeBranchPolicy.isChildWorktree")(function* <E>(
  thread: WorktreeOrigin | null,
  findSource: (id: ThreadId) => Effect.Effect<WorktreeOrigin | null, E>,
) {
  if (thread == null) return false;
  if (
    thread.lineage?.relationshipToParent === "subagent" ||
    thread.delegatedFrom != null ||
    thread.lineage?.sideChat === true
  )
    return true;
  const parent = thread.lineage?.parentThreadId;
  const source = thread.forkedFrom?.type === "run" ? thread.forkedFrom.threadId : null;
  if (source !== null && (yield* findSource(source))?.lineage?.sideChat === true) return true;
  return (
    thread.lineage?.relationshipToParent === "fork" &&
    parent != null &&
    parent !== source &&
    (yield* findSource(parent))?.lineage?.sideChat === true
  );
});

export function worktreeMainBranchOnly(settings: ServerSettings, childWorktree?: boolean) {
  return childWorktree
    ? settings.childWorktreesMainBranchOnly
    : settings.newWorktreesMainBranchOnly;
}

export function worktreeMainBranchError(childWorktree?: boolean) {
  return childWorktree
    ? "Subagent and side chat worktrees must start from main or master. Change this in Settings → Worktrees."
    : "New worktree branches must start from main or master. Change this in Settings → Worktrees.";
}

export const isMainWorktreeBase = Effect.fn("worktreeBranchPolicy.isMainWorktreeBase")(function* (
  git: Pick<GitVcsDriver["Service"], "execute">,
  cwd: string,
  base: string,
  childWorktree?: boolean,
) {
  const { stdout: symbolic } = yield* git.execute({
    operation: "worktreeBranchPolicy.resolveBase",
    cwd,
    args: ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", base],
  });
  const ref = symbolic.trim();
  const pinned =
    childWorktree === true && ref === "" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base);
  const { stdout } = pinned
    ? yield* git.execute({
        operation: "worktreeBranchPolicy.resolvePinnedBase",
        cwd,
        args: [
          "for-each-ref",
          `--points-at=${base}`,
          "--format=%(refname)",
          "refs/heads/main",
          "refs/heads/master",
          "refs/remotes",
        ],
      })
    : { stdout: ref };
  const refs = stdout.trim().split("\n");
  if (refs.some((name) => name.startsWith("refs/heads/") && isMainOrMasterBranch(name)))
    return true;
  if (!refs.some((name) => name.startsWith("refs/remotes/"))) return false;
  const remotes = parseRemoteNames(
    (yield* git.execute({
      operation: "worktreeBranchPolicy.listRemotes",
      cwd,
      args: ["remote"],
    })).stdout,
  );
  return refs.some((name) => {
    if (!name.startsWith("refs/remotes/")) return false;
    const remote = parseRemoteRefWithRemoteNames(name.slice("refs/remotes/".length), remotes);
    return remote?.branchName === "main" || remote?.branchName === "master";
  });
});

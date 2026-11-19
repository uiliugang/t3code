import type { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { GitVcsDriver } from "../vcs/GitVcsDriver.ts";

export function worktreeMainBranchOnly(settings: ServerSettings, childWorktree?: boolean) {
  return childWorktree
    ? settings.childWorktreesMainBranchOnly
    : settings.newWorktreesMainBranchOnly;
}

export function worktreeMainBranchError(childWorktree?: boolean) {
  return childWorktree
    ? "Subagent and side chat worktrees must start from main or master. Change this in Settings → Worktrees."
    : "New worktree branches must start from main or master. Change this in Settings → Source Control → Branch management.";
}

export const isPinnedMainBranchTip = Effect.fn("worktreeBranchPolicy.isPinnedMainBranchTip")(
  function* (git: Pick<GitVcsDriver["Service"], "execute">, cwd: string, ref: string) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref)) return false;
    const { stdout } = yield* git.execute({
      operation: "worktreeBranchPolicy.resolvePinnedBase",
      cwd,
      args: [
        "for-each-ref",
        `--points-at=${ref}`,
        "--format=%(refname)",
        "refs/heads/main",
        "refs/heads/master",
      ],
    });
    return stdout
      .split("\n")
      .some((name) => name === "refs/heads/main" || name === "refs/heads/master");
  },
);

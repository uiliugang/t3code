import type { BranchIssue, EnvironmentId } from "@t3tools/contracts";

export interface IssueBranch {
  environmentId: EnvironmentId;
  cwd: string;
  branch: string;
  provider: string;
  published: boolean;
  issues: readonly BranchIssue[];
}

export function groupBranchIssues(branches: readonly IssueBranch[], currentCwd: string | null) {
  const groups = new Map<string, { issue: BranchIssue; branches: IssueBranch[] }>();
  const unlinked: IssueBranch[] = [];
  const seen = new Set<string>();
  for (const branch of branches.toSorted(
    (a, b) => Number(b.cwd === currentCwd) - Number(a.cwd === currentCwd),
  )) {
    const targetKey = JSON.stringify([branch.environmentId, branch.cwd, branch.branch]);
    if (seen.has(targetKey)) continue;
    seen.add(targetKey);
    if (branch.issues.length === 0) unlinked.push(branch);
    for (const issue of branch.issues) {
      const key = JSON.stringify([issue.provider, issue.url]);
      const group = groups.get(key);
      if (group) {
        if (!group.branches.includes(branch)) group.branches.push(branch);
      } else groups.set(key, { issue, branches: [branch] });
    }
  }
  return { groups: [...groups.values()], unlinked };
}

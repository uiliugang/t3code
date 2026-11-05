import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, type BranchIssue } from "@t3tools/contracts";
import { groupBranchIssues, type IssueBranch } from "./branchIssueGroups";

const issue: BranchIssue = {
  provider: "github",
  id: "1",
  repository: "acme/web",
  url: "https://github.com/acme/web/issues/1",
  title: "Shared work",
  state: "open",
  association: "local",
};
const branch: IssueBranch = {
  environmentId: EnvironmentId.make("test"),
  cwd: "/web",
  branch: "feat/web",
  provider: "github",
  published: true,
  issues: [issue],
};

describe("groupBranchIssues", () => {
  it("merges shared issues, keeps distinct repository issues, and puts the current branch first", () => {
    const api = { ...branch, cwd: "/api", branch: "feat/api" };
    const separate = {
      ...branch,
      cwd: "/cli",
      issues: [{ ...issue, repository: "acme/cli", url: "https://github.com/acme/cli/issues/1" }],
    };
    const result = groupBranchIssues([branch, api, separate, branch], "/api");
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]?.branches).toEqual([api, branch]);
    expect(result.groups[1]?.branches).toEqual([separate]);
    expect(result.unlinked).toEqual([]);
  });

  it("collects published and unpublished empty branches without counting them as issues", () => {
    const unpublished = { ...branch, published: false, issues: [] };
    const published = { ...branch, cwd: "/api", issues: [] };
    expect(groupBranchIssues([unpublished, published, unpublished], null)).toEqual({
      groups: [],
      unlinked: [unpublished, published],
    });
    expect(groupBranchIssues([], null)).toEqual({ groups: [], unlinked: [] });
  });
});

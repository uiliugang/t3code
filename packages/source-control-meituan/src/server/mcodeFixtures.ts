import type { PullRequest } from "./mcodeJson.ts";

export const pullRequest = {
  id: 22,
  title: "Update service",
  state: "OPEN",
  type: "normal",
  author: { mis: "author", name: "Author" },
  fromRef: { branch: "feature/service", repo: "team/service", commitId: "a".repeat(40) },
  toRef: { branch: "master", repo: "team/service", commitId: "b".repeat(40) },
  additions: 5,
  deletions: 2,
  commitNum: 1,
  reviewers: [{ mis: "reviewer", name: "Reviewer", approved: false, action: "NULL" }],
  mergeable: true,
  description: "Description",
  createdDate: "2026-10-16 18:36",
  url: "https://dev.sankuai.com/code/repo-detail/team/service/pr/22/overview?codeArea=mcode",
} satisfies PullRequest;

export const repositoryRef = {
  cwd: "/repo",
  repository: "team/service",
  host: "git.sankuai.com",
  number: 22,
};

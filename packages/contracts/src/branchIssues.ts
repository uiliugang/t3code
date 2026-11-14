import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BranchIssueRef = Schema.Struct({
  provider: Schema.Literals(["github", "meituan"]),
  id: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
});
export type BranchIssueRef = typeof BranchIssueRef.Type;

export const BranchIssue = Schema.Struct({
  ...BranchIssueRef.fields,
  title: Schema.String,
  state: Schema.String,
  association: Schema.Literals(["local", "remote"]),
});
export type BranchIssue = typeof BranchIssue.Type;

export const BranchIssueDetail = Schema.Struct({
  title: Schema.String,
  state: Schema.String,
  body: Schema.String,
  bodyFormat: Schema.Literals(["markdown", "html"]),
});
export type BranchIssueDetail = typeof BranchIssueDetail.Type;

export const BranchIssuesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
});
export type BranchIssuesInput = typeof BranchIssuesInput.Type;
export const BranchIssuesResult = Schema.Struct({
  provider: Schema.String,
  published: Schema.Boolean,
  issues: Schema.Array(BranchIssue),
});
export const BranchIssueDetailInput = Schema.Struct({
  ...BranchIssuesInput.fields,
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export const BranchIssuesUpdateInput = Schema.Struct({
  ...BranchIssuesInput.fields,
  urls: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50),
  ),
  action: Schema.Literals(["associate", "disassociate"]),
});
export type BranchIssuesUpdateInput = typeof BranchIssuesUpdateInput.Type;
export const IssueBranchesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
});
export const IssueBranchesResult = Schema.Array(
  Schema.Struct({ name: Schema.String, linked: Schema.Boolean }),
);

export class BranchIssueError extends Schema.TaggedError<
  BranchIssueError,
  { readonly brand: unique symbol }
>()("BranchIssueError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "unsupported",
    "invalid-link",
    "failed",
    "unavailable",
    "unlink-failed",
    "unpublished",
    "issue-limit",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    switch (this.reason) {
      case "unpublished":
        return "Push this branch before linking an issue.";
      case "issue-limit":
        return "Each branch can link one issue. Unlink the existing issue first.";
      case "unsupported":
        return "Linked issues are supported for GitHub and Meituan Code repositories.";
      case "invalid-link":
        return "Enter valid issue links for this repository's hosting platform.";
      case "unavailable":
        return "The issue could not be read. Check your access and sign-in on the server.";
      case "failed":
        return "The issue association could not be updated. Refresh to check which links succeeded.";
      case "unlink-failed":
        return "MEP could not unlink this issue. Check your access and the work item and branch workflow states.";
    }
  }
}

export function parseBranchIssueUrl(value: string): BranchIssueRef | null {
  const url = URL.parse(value.trim());
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (url.hostname === "github.com") {
    const match = /^\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
    return match
      ? {
          provider: "github",
          repository: match[1]!,
          id: match[2]!,
          url: `https://github.com/${match[1]}/issues/${match[2]}`,
        }
      : null;
  }
  if (url.hostname !== "mep.sankuai.com") return null;
  const detail =
    /^\/app\/ones\/space\/([1-9]\d*)\/workItem\/(requirement|devtask|defect|task)\/detail\/([1-9]\d*)\/?$/.exec(
      url.pathname,
    );
  if (detail)
    return {
      provider: "meituan",
      repository: detail[1]!,
      id: detail[3]!,
      url: `https://mep.sankuai.com/app/ones/space/${detail[1]}/workItem/${detail[2]}/detail/${detail[3]}`,
    };
  const drawer =
    /^\/app\/ones\/space\/([1-9]\d*)\/workItem\/(requirement|devtask|defect|task)\/?$/.exec(
      url.pathname,
    );
  const id = url.searchParams.get("openDrawerIssueId");
  const space = url.searchParams.get("openDrawerSpaceId") ?? drawer?.[1];
  if (!drawer || !id || !/^[1-9]\d*$/.test(id) || !space || !/^[1-9]\d*$/.test(space)) return null;
  return {
    provider: "meituan",
    repository: space,
    id,
    url: `https://mep.sankuai.com/app/ones/space/${space}/workItem/${drawer[2]}/detail/${id}`,
  };
}

export function branchIssuePlaceholder(provider: string): string {
  return provider === "meituan" ? "Paste a MEP ONES work item link" : "Paste a GitHub Issue link";
}

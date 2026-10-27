import {
  PositiveInt,
  NonNegativeInt,
  TrimmedNonEmptyString,
  type ChangeRequest,
  type PullRequestCheck,
  type PullRequestActor,
} from "@t3tools/contracts";
import type { ProviderChangeRequest } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { definition } from "../shared/definition.ts";

export const RepositoryName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-zA-Z0-9._~-]+\/[a-zA-Z0-9._-]+$/u),
);
const Timestamp = Schema.String.check(
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value.replace(" ", "T")))),
);
const User = Schema.Struct({ mis: Schema.String, name: Schema.String });
const Ref = Schema.Struct({
  branch: TrimmedNonEmptyString,
  repo: RepositoryName,
  commitId: Schema.String,
});

export const PullRequest = Schema.Struct({
  id: PositiveInt,
  title: TrimmedNonEmptyString,
  state: Schema.Literals(["OPEN", "DRAFT", "DECLINED", "CLOSED", "MERGED"]),
  type: Schema.String,
  author: Schema.Struct({ mis: TrimmedNonEmptyString, name: Schema.String }),
  fromRef: Ref,
  toRef: Ref,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  commitNum: NonNegativeInt,
  reviewers: Schema.Array(
    Schema.Struct({
      ...User.fields,
      approved: Schema.Boolean,
      action: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  mergeable: Schema.optional(Schema.Unknown),
  description: Schema.String,
  createdDate: Timestamp,
  url: Schema.String,
});
export type PullRequest = typeof PullRequest.Type;

export const Repository = Schema.Struct({
  fullName: RepositoryName,
  sshURL: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
});
export const Branch = Schema.Struct({
  name: TrimmedNonEmptyString,
  issues: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});
export const RepositorySettings = Schema.Struct({ requireIssueAssociated: Schema.Boolean });
const Check = Schema.Struct({
  name: Schema.String,
  state: Schema.String,
  description: Schema.String,
  link: Schema.String,
});
export const Checks = Schema.Struct({
  statusChecks: Schema.Array(Check),
  mergeChecks: Schema.Array(Check),
});
export const Comments = Schema.Array(
  Schema.Struct({
    id: TrimmedNonEmptyString,
    assignmentId: Schema.optional(Schema.String),
    author: Schema.String,
    text: Schema.String,
    path: Schema.String,
    line: Schema.Number,
    state: Schema.String,
    createdDate: Timestamp,
    source: Schema.String,
    replies: Schema.optional(Schema.Number),
  }),
);
export const Reviewers = Schema.Union([
  Schema.Array(User),
  Schema.Struct({ candidates: Schema.Array(User) }),
]);

export const timestamp = (value: string): string =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse(value.replace(" ", "T"))));

export function actor(user: typeof User.Type): PullRequestActor | null {
  return user.mis ? { login: user.mis, name: user.name || null, avatarUrl: null } : null;
}

export function changeRequest(pr: PullRequest): ChangeRequest {
  return {
    provider: definition.kind,
    number: pr.id,
    title: pr.title,
    url: definition.changeRequestUrl({
      host: "git.sankuai.com",
      repository: pr.toRef.repo,
      number: pr.id,
    }),
    baseRefName: pr.toRef.branch,
    headRefName: pr.fromRef.branch,
    ...(pr.fromRef.commitId ? { headSha: pr.fromRef.commitId } : {}),
    state:
      pr.state === "MERGED"
        ? "merged"
        : pr.state === "OPEN" || pr.state === "DRAFT"
          ? "open"
          : "closed",
    isDraft: pr.state === "DRAFT" || pr.type === "draft",
    isCrossRepository: pr.fromRef.repo.toLowerCase() !== pr.toRef.repo.toLowerCase(),
    headRepositoryNameWithOwner: pr.fromRef.repo,
    headRepositoryOwnerLogin: pr.fromRef.repo.split("/")[0]!,
    updatedAt: Option.none(),
    closedAt: null,
    mergedAt: null,
  };
}

export function providerChangeRequest(pr: PullRequest): ProviderChangeRequest {
  const summary = changeRequest(pr);
  return {
    number: pr.id,
    title: pr.title,
    url: summary.url,
    author: actor(pr.author),
    headBranch: pr.fromRef.branch,
    headRepositoryNameWithOwner: pr.fromRef.repo,
    baseBranch: pr.toRef.branch,
    state: summary.state,
    isDraft: summary.isDraft === true,
    mergeability: pr.mergeable === true ? "mergeable" : "unknown",
    additions: pr.additions,
    deletions: pr.deletions,
    createdAt: timestamp(pr.createdDate),
    // code-cli exposes creation time only; list pagination uses delivered offsets, not this field.
    updatedAt: timestamp(pr.createdDate),
    reviewRequestLogins: pr.reviewers.filter((user) => !user.approved).map((user) => user.mis),
    labels: [],
    reviewDecision: pr.reviewers.some((user) => user.action === "REJECTED")
      ? "changes-requested"
      : null,
  };
}

export function checksFromJson(result: typeof Checks.Type): ReadonlyArray<PullRequestCheck> {
  return [...result.statusChecks, ...result.mergeChecks].map((check) => ({
    name: check.name || "Meituan Code check",
    status: /^(SUCCESS|SUCCESSFUL|PASSED)$/iu.test(check.state)
      ? "success"
      : /^(FAILED|FAILURE|ERROR|VETOED)$/iu.test(check.state)
        ? "failure"
        : /^SKIPPED$/iu.test(check.state)
          ? "skipped"
          : /^(CANCELLED|CANCELED)$/iu.test(check.state)
            ? "cancelled"
            : "pending",
    description: check.description || null,
    url: /^https?:\/\//iu.test(check.link) ? check.link : null,
  }));
}

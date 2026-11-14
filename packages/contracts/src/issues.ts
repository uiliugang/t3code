import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectId } from "./baseSchemas.ts";

export const IssueProvider = Schema.Literals(["github", "meituan"]);
export type IssueProvider = typeof IssueProvider.Type;
const Text = Schema.String.check(Schema.isMaxLength(1000));
export const IssueSource = Schema.Struct({
  provider: IssueProvider,
  scope: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  host: TrimmedNonEmptyString.check(Schema.isMaxLength(253)),
});
export type IssueSource = typeof IssueSource.Type;
export const IssueProjectSources = Schema.Record(ProjectId, Schema.Array(IssueSource));
export const IssueTarget = Schema.Struct({
  projectId: ProjectId,
  provider: IssueProvider,
  scope: Schema.optionalKey(TrimmedNonEmptyString),
});
export const IssueSourcesInput = Schema.Struct({
  projectIds: Schema.Array(ProjectId).check(Schema.isMaxLength(500)),
  refresh: Schema.optionalKey(Schema.Boolean),
});
export const IssueProjectSource = Schema.Struct({
  projectId: ProjectId,
  repository: Schema.NullOr(Schema.String),
  sources: Schema.Array(IssueSource),
  manual: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});
export const IssueSourcesResult = Schema.Array(IssueProjectSource);
export type IssueTarget = typeof IssueTarget.Type;
export const IssueOption = Schema.Struct({
  value: Text,
  label: Text,
  category: Schema.optional(Schema.String),
});
export type IssueOption = typeof IssueOption.Type;
export const Issue = Schema.Struct({
  id: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  title: Schema.String,
  state: Schema.String,
  stateCategory: Schema.Literals(["todo", "doing", "done", "other"]),
  type: Schema.String,
  assignees: Schema.Array(IssueOption),
  priority: Schema.String,
  updatedAt: Schema.String,
});
export type Issue = typeof Issue.Type;
export const IssueListInput = Schema.Struct({
  provider: IssueProvider,
  projectId: Schema.optional(ProjectId),
  assignee: Schema.String.check(Schema.isMaxLength(200)),
  query: Schema.String.check(Schema.isMaxLength(200)),
  page: PositiveInt.check(Schema.isLessThanOrEqualTo(1000)),
});
export type IssueListInput = typeof IssueListInput.Type;
export const IssueListResult = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      source: IssueSource,
      projectIds: Schema.Array(ProjectId),
      issues: Schema.Array(Issue),
      hasMore: Schema.Boolean,
    }),
  ),
  failures: Schema.Array(Schema.Struct({ projectId: ProjectId, reason: Schema.String })),
});
export const IssueReadInput = Schema.Struct({ ...IssueTarget.fields, id: TrimmedNonEmptyString });
export const IssueDetail = Schema.Struct({
  ...Issue.fields,
  body: Schema.String,
  bodyFormat: Schema.Literals(["markdown", "html"]),
  transitions: Schema.Array(IssueOption),
});
export type IssueDetail = typeof IssueDetail.Type;
export const IssuePeopleInput = Schema.Struct({ ...IssueTarget.fields, query: Text });
export const IssueMetadataInput = Schema.Struct({
  ...IssueTarget.fields,
  type: Schema.Literals(["REQUIREMENT", "DEVTASK", "DEFECT"]),
  subtype: Schema.String,
  query: Schema.optionalKey(Text),
});
export const IssueField = Schema.Struct({
  variable: Text,
  label: Text,
  type: Schema.Literals(["text", "select", "person", "date"]),
  required: Schema.Boolean,
  multiple: Schema.Boolean,
  options: Schema.Array(IssueOption),
});
export const IssueMetadata = Schema.Struct({
  subtypes: Schema.Array(IssueOption),
  fields: Schema.Array(IssueField),
});
export const IssueCreateInput = Schema.Struct({
  ...IssueMetadataInput.fields,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  body: Schema.String.check(Schema.isMaxLength(100_000)),
  assignees: Schema.Array(Text).check(Schema.isMaxLength(20)),
  fields: Schema.Record(Text, Schema.String.check(Schema.isMaxLength(4000))),
});
export const IssueSetStateInput = Schema.Struct({ ...IssueReadInput.fields, state: Text });
export class IssueError extends Schema.TaggedError<IssueError>()("IssueError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "unavailable",
    "unsupported",
    "invalid-target",
    "invalid-state",
    "validation",
    "outcome-unknown",
  ]),
  fields: Schema.optional(Schema.Array(Schema.Struct({ variable: Text, message: Text }))),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    switch (this.reason) {
      case "unsupported":
        return "This environment does not support this issue operation.";
      case "invalid-target":
        return "Configure an issue source for this project first.";
      case "invalid-state":
        return "This transition is no longer available. Refresh the issue.";
      case "validation":
        return "Some issue fields need attention. Check the highlighted fields.";
      case "outcome-unknown":
        return "The request may have succeeded. Check the source before submitting again.";
      default:
        return "Could not access issues. Check the connection and your account on this environment.";
    }
  }
}

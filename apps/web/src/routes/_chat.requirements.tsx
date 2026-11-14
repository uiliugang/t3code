import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProjectId, IssueProvider, WorkItemId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { RequirementsPage } from "../components/requirements/RequirementsPage";

const Search = Schema.Struct({
  provider: Schema.optionalKey(IssueProvider),
  source: Schema.optionalKey(Schema.Literals(["all", "meituan", "github", "local"])),
  issueProvider: Schema.optionalKey(IssueProvider),
  workItemId: Schema.optionalKey(WorkItemId),
  archived: Schema.optionalKey(Schema.Boolean),
  environmentId: Schema.optionalKey(EnvironmentId),
  projectId: Schema.optionalKey(ProjectId),
  assignee: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  q: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  view: Schema.optionalKey(Schema.Literals(["board", "list"])),
  issueId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
  issueProjectId: Schema.optionalKey(ProjectId),
  issueScope: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  local: Schema.optionalKey(Schema.Boolean),
});
export type RequirementsSearch = typeof Search.Type;
const decodeSearch = Schema.decodeSync(Search);
export const Route = createFileRoute("/_chat/requirements")({
  validateSearch: (raw: Record<string, unknown>): RequirementsSearch => decodeSearch(raw),
  component: RequirementsPage,
});

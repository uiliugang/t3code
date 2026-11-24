import { createFileRoute } from "@tanstack/react-router";
import { RequirementFilters } from "@t3tools/client-runtime/saved-views";
import {
  EnvironmentId,
  ISSUE_LIST_MAX_EXCLUDED_PROJECTS,
  IssueInvolvement,
  IssueListSort,
  IssueListState,
  ProjectId,
  IssueProvider,
  PullRequestRef,
  WorkItemId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { RequirementsPage } from "../components/requirements/RequirementsPage";

const Search = Schema.Struct({
  mode: Schema.optionalKey(Schema.Literals(["board", "issues"])),
  labels: Schema.optionalKey(RequirementFilters.fields.labels),
  trackerLabels: Schema.optionalKey(RequirementFilters.fields.labels),
  provider: Schema.optionalKey(IssueProvider),
  source: Schema.optionalKey(
    Schema.Literals(["all", "meituan", "github", "gitlab", "linear", "local"]),
  ),
  issueProvider: Schema.optionalKey(Schema.Literals(["meituan", "github", "gitlab", "linear"])),
  issueTracker: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  issueHost: Schema.optionalKey(Schema.String),
  workItemId: Schema.optionalKey(WorkItemId),
  pullRequest: Schema.optionalKey(
    PullRequestRef.mapFields(({ projectId, host, repository, number }) => ({
      projectId,
      host,
      repository,
      number,
    })),
  ),
  archived: Schema.optionalKey(Schema.Boolean),
  environmentId: Schema.optionalKey(EnvironmentId),
  detailEnvironmentId: Schema.optionalKey(EnvironmentId),
  projectId: Schema.optionalKey(ProjectId),
  assignee: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  trackerAssignee: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  workflowInvolvement: Schema.optionalKey(IssueInvolvement),
  issueState: Schema.optionalKey(IssueListState),
  workflowSort: Schema.optionalKey(IssueListSort),
  who: Schema.optionalKey(IssueInvolvement),
  status: Schema.optionalKey(IssueListState),
  order: Schema.optionalKey(Schema.Literal("created")),
  host: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  hideProjects: Schema.optionalKey(
    Schema.Array(Schema.Tuple([EnvironmentId, ProjectId])).check(
      Schema.isMaxLength(ISSUE_LIST_MAX_EXCLUDED_PROJECTS),
    ),
  ),
  q: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  trackerQuery: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  view: Schema.optionalKey(Schema.Literals(["board", "list"])),
  issueId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  issueProjectId: Schema.optionalKey(ProjectId),
  issueScope: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  issueUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_048))),
  local: Schema.optionalKey(Schema.Boolean),
});
export type RequirementsSearch = typeof Search.Type;
const decodeSearch = Schema.decodeSync(Search);

// The router parses a bare `issueId=17` as a number; identifiers stay strings.
const STRING_KEYS = [
  "issueId",
  "issueScope",
  "issueHost",
  "issueTracker",
  "issueUrl",
  "host",
  "q",
  "trackerQuery",
  "assignee",
  "trackerAssignee",
] as const;

export const Route = createFileRoute("/_chat/requirements")({
  validateSearch: (raw: Record<string, unknown>): RequirementsSearch => {
    const normalized = { ...raw };
    for (const key of STRING_KEYS) {
      if (typeof normalized[key] === "number") normalized[key] = String(normalized[key]);
    }
    if (typeof normalized.q === "string") normalized.q = normalized.q.slice(0, 200);
    if (typeof normalized.trackerQuery === "string")
      normalized.trackerQuery = normalized.trackerQuery.slice(0, 200);
    return decodeSearch(normalized);
  },
  component: RequirementsPage,
});

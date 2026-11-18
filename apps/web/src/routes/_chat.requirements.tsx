import { createFileRoute } from "@tanstack/react-router";
import { RequirementFilters } from "@t3tools/client-runtime/saved-views";
import {
  EnvironmentId,
  ProjectId,
  IssueProvider,
  PullRequestRef,
  WorkItemId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { RequirementsPage } from "../components/requirements/RequirementsPage";

const Search = Schema.Struct({
  labels: Schema.optionalKey(RequirementFilters.fields.labels),
  provider: Schema.optionalKey(IssueProvider),
  source: Schema.optionalKey(
    Schema.Literals(["all", "meituan", "github", "gitlab", "linear", "local"]),
  ),
  issueProvider: Schema.optionalKey(Schema.Literals(["meituan", "github", "gitlab", "linear"])),
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
  q: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  view: Schema.optionalKey(Schema.Literals(["board", "list"])),
  issueId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
  issueProjectId: Schema.optionalKey(ProjectId),
  issueScope: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  local: Schema.optionalKey(Schema.Boolean),
});
export type RequirementsSearch = typeof Search.Type;
const decodeSearch = Schema.decodeSync(Search);

// The router parses a bare `issueId=17` as a number; identifiers stay strings.
const STRING_KEYS = ["issueId", "issueScope", "issueHost", "q", "assignee"] as const;

export const Route = createFileRoute("/_chat/requirements")({
  validateSearch: (raw: Record<string, unknown>): RequirementsSearch => {
    const normalized = { ...raw };
    for (const key of STRING_KEYS) {
      if (typeof normalized[key] === "number") normalized[key] = String(normalized[key]);
    }
    return decodeSearch(normalized);
  },
  component: RequirementsPage,
});

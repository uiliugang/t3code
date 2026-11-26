import type { EnvironmentId, ProjectId, WorkItemId } from "@t3tools/contracts";
import type { RequirementTracker } from "@t3tools/client-runtime/work-item";
import type { RightPanelSurface } from "../../rightPanelStore";
import type { IssuesSearch } from "../issue/IssuesPage";
import type { RequirementsSearch } from "../../routes/_chat.requirements";

export type RequirementSearchPatch = {
  [Key in keyof RequirementsSearch]?: RequirementsSearch[Key] | undefined;
};

export function isRequirementTracker(value: string | undefined): value is RequirementTracker {
  return value === "meituan" || value === "github" || value === "gitlab" || value === "linear";
}

export function patchRequirementsSearch(
  previous: RequirementSearchPatch,
  patch: RequirementSearchPatch,
): RequirementsSearch {
  return Object.fromEntries(
    Object.entries({ ...previous, ...patch }).filter(([, value]) => value !== undefined),
  );
}

export function requirementsSearchFromIssuesSearch(search: IssuesSearch): RequirementsSearch {
  return patchRequirementsSearch(
    {},
    {
      mode: "issues",
      who: search.who,
      status: search.status,
      hideProjects: search.hideProjects,
      host: search.host,
      trackerQuery: search.q,
      trackerLabels: search.label,
      trackerAssignee: search.assignee,
      order: search.order,
      detailEnvironmentId: search.selectedEnvironmentId,
      issueProjectId: search.selectedProjectId,
      issueHost: search.selectedHost,
      issueTracker: search.tracker,
      issueScope: search.scope,
      issueId: search.key,
      issueUrl: search.url,
    },
  );
}

export function requirementSelection(surface: RightPanelSurface | null): RequirementSearchPatch {
  const cleared = {
    detailEnvironmentId: undefined,
    workItemId: undefined,
    issueId: undefined,
    issueProjectId: undefined,
    issueProvider: undefined,
    issueTracker: undefined,
    issueScope: undefined,
    issueHost: undefined,
    issueUrl: undefined,
    pullRequest: undefined,
  };
  const detailEnvironmentId =
    surface && "environmentId" in surface
      ? (surface.environmentId as EnvironmentId | undefined)
      : undefined;
  switch (surface?.kind) {
    case "work-item":
      return { ...cleared, detailEnvironmentId, workItemId: surface.workItemId as WorkItemId };
    case "requirement-issue":
      return {
        ...cleared,
        detailEnvironmentId,
        issueId: surface.issueId,
        issueProjectId: surface.projectId as ProjectId,
        issueProvider: surface.provider,
        issueScope: surface.scope,
        issueHost: surface.host,
        issueUrl: surface.url,
      };
    case "issue":
      return {
        ...cleared,
        detailEnvironmentId,
        issueId: surface.key,
        issueProjectId: surface.projectId as ProjectId,
        issueTracker: surface.tracker,
        issueScope: surface.scope,
        issueHost: surface.host,
        issueUrl: surface.url,
      };
    case "pull-request":
      return {
        ...cleared,
        detailEnvironmentId,
        pullRequest: {
          projectId: surface.projectId as ProjectId,
          repository: surface.repository,
          number: surface.number,
          ...(surface.host ? { host: surface.host } : {}),
          ...(surface.url ? { url: surface.url } : {}),
        },
      };
    default:
      return cleared;
  }
}

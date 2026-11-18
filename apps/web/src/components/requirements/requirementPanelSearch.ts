import type { EnvironmentId, ProjectId, WorkItemId } from "@t3tools/contracts";
import type { RightPanelSurface } from "../../rightPanelStore";
import type { RequirementsSearch } from "../../routes/_chat.requirements";

export type RequirementSearchPatch = {
  [Key in keyof RequirementsSearch]?: RequirementsSearch[Key] | undefined;
};

export function patchRequirementsSearch(
  previous: RequirementSearchPatch,
  patch: RequirementSearchPatch,
): RequirementsSearch {
  return Object.fromEntries(
    Object.entries({ ...previous, ...patch }).filter(([, value]) => value !== undefined),
  );
}

export function requirementSelection(surface: RightPanelSurface | null): RequirementSearchPatch {
  const cleared = {
    detailEnvironmentId: undefined,
    workItemId: undefined,
    issueId: undefined,
    issueProjectId: undefined,
    issueProvider: undefined,
    issueScope: undefined,
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
        },
      };
    default:
      return cleared;
  }
}

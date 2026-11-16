import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { RequirementSource } from "@t3tools/client-runtime/work-item";

export interface RequirementProjectRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface RequirementFilterState {
  readonly environmentId: EnvironmentId | null;
  readonly source: RequirementSource;
  readonly project: RequirementProjectRef | null;
  readonly assignee: string;
  readonly archived: boolean;
  readonly queryText: string;
}

export const DEFAULT_REQUIREMENT_FILTER_STATE: RequirementFilterState = {
  environmentId: null,
  source: "all",
  project: null,
  assignee: "me",
  archived: false,
  queryText: "",
};

export function requirementProjectKey(project: {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}): string {
  return `${project.environmentId}/${project.id}`;
}

export function isRequirementFilterCustomized(state: RequirementFilterState): boolean {
  return (
    state.environmentId !== null ||
    state.source !== "all" ||
    state.project !== null ||
    state.assignee !== "me" ||
    state.archived ||
    state.queryText.trim().length > 0
  );
}

export function findSelectedRequirementProject<
  Project extends { readonly environmentId: EnvironmentId; readonly id: ProjectId },
>(projects: ReadonlyArray<Project>, selected: RequirementProjectRef | null): Project | undefined {
  if (!selected) return undefined;
  return projects.find(
    (project) =>
      project.id === selected.projectId && project.environmentId === selected.environmentId,
  );
}

export function applyRequirementFilterSelection<
  Project extends { readonly environmentId: EnvironmentId; readonly id: ProjectId },
>(
  state: RequirementFilterState,
  selectionId: string,
  projects: ReadonlyArray<Project>,
): RequirementFilterState {
  if (selectionId.startsWith("env:")) {
    const next = selectionId.slice(4);
    return {
      ...state,
      environmentId: next ? EnvironmentId.make(next) : null,
      project: null,
    };
  }
  if (selectionId.startsWith("source:")) {
    return {
      ...state,
      source: selectionId.slice(7) as RequirementSource,
      assignee: "me",
    };
  }
  if (selectionId.startsWith("project:")) {
    const key = selectionId.slice(8);
    const project = projects.find((candidate) => requirementProjectKey(candidate) === key);
    return project
      ? {
          ...state,
          environmentId: project.environmentId,
          project: { environmentId: project.environmentId, projectId: project.id },
        }
      : { ...state, project: null };
  }
  if (selectionId.startsWith("assignee:")) {
    return { ...state, assignee: selectionId.slice(9) };
  }
  return state;
}

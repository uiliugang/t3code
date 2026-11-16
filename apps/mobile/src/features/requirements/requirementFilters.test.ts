import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  DEFAULT_REQUIREMENT_FILTER_STATE,
  applyRequirementFilterSelection,
  findSelectedRequirementProject,
  isRequirementFilterCustomized,
} from "./requirementFilters";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const sharedProjectId = ProjectId.make("repo-1");

const projects = [
  { environmentId: envA, id: sharedProjectId, title: "Alpha Repo" },
  { environmentId: envB, id: sharedProjectId, title: "Beta Repo" },
] as const;

describe("requirementFilters", () => {
  it("treats non-empty search text as an active filter and clears it on reset", () => {
    expect(isRequirementFilterCustomized(DEFAULT_REQUIREMENT_FILTER_STATE)).toBe(false);
    expect(
      isRequirementFilterCustomized({
        ...DEFAULT_REQUIREMENT_FILTER_STATE,
        queryText: "   ",
      }),
    ).toBe(false);
    expect(
      isRequirementFilterCustomized({
        ...DEFAULT_REQUIREMENT_FILTER_STATE,
        queryText: "login bug",
      }),
    ).toBe(true);
  });

  it("distinguishes projects with identical ProjectId across environments", () => {
    const selectedOnB = applyRequirementFilterSelection(
      DEFAULT_REQUIREMENT_FILTER_STATE,
      "project:env-b/repo-1",
      projects,
    );
    expect(selectedOnB.environmentId).toBe(envB);
    expect(selectedOnB.project).toEqual({
      environmentId: envB,
      projectId: sharedProjectId,
    });
    expect(findSelectedRequirementProject(projects, selectedOnB.project)?.title).toBe("Beta Repo");

    const clearedEnv = applyRequirementFilterSelection(selectedOnB, "env:", projects);
    expect(clearedEnv.environmentId).toBeNull();
    expect(clearedEnv.project).toBeNull();
  });

  it("resets assignee back to 'me' when switching requirement source", () => {
    const withCustomAssignee = {
      ...DEFAULT_REQUIREMENT_FILTER_STATE,
      assignee: "octocat",
    };
    const switched = applyRequirementFilterSelection(withCustomAssignee, "source:local", projects);
    expect(switched.source).toBe("local");
    expect(switched.assignee).toBe("me");
  });
});

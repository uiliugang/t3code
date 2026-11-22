import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { requirementSelection, requirementsSearchFromIssuesSearch } from "./requirementPanelSearch";

it("maps legacy issue list filters and the selected issue onto the unified requirements route", () => {
  const environmentId = EnvironmentId.make("env");
  const projectId = ProjectId.make("project");
  expect(
    requirementsSearchFromIssuesSearch({
      who: "authored",
      status: "closed",
      hideProjects: [[environmentId, projectId]],
      host: "github.example.com",
      q: "crash",
      label: ["bug"],
      assignee: "alice",
      order: "created",
      selectedEnvironmentId: environmentId,
      selectedProjectId: projectId,
      selectedHost: "github.example.com",
      tracker: "github",
      scope: "acme/app",
      key: "42",
    }),
  ).toEqual({
    mode: "issues",
    who: "authored",
    status: "closed",
    hideProjects: [[environmentId, projectId]],
    host: "github.example.com",
    q: "crash",
    labels: ["bug"],
    assignee: "alice",
    order: "created",
    detailEnvironmentId: environmentId,
    issueProjectId: projectId,
    issueHost: "github.example.com",
    issueProvider: "github",
    issueScope: "acme/app",
    issueId: "42",
  });
});

it("keeps standalone tracker selections distinct from requirement tracker selections", () => {
  expect(
    requirementSelection({
      id: "issue:linear:team:ENG-42",
      kind: "issue",
      environmentId: "env",
      projectId: "project",
      tracker: "jira",
      host: "jira.example.com",
      scope: "TEAM",
      key: "TEAM-42",
    }),
  ).toMatchObject({
    detailEnvironmentId: "env",
    issueProjectId: "project",
    issueTracker: "jira",
    issueHost: "jira.example.com",
    issueScope: "TEAM",
    issueId: "TEAM-42",
  });
  expect(
    requirementSelection({
      id: "requirement-issue:github:42",
      kind: "requirement-issue",
      environmentId: "env",
      projectId: "project",
      provider: "github",
      scope: "acme/app",
      issueId: "42",
    }),
  ).toMatchObject({ issueProvider: "github", issueTracker: undefined, issueId: "42" });
});

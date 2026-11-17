import {
  RequirementIssueError,
  RequirementIssueListResult,
  WS_METHODS,
  type EnvironmentId,
  type SourceControlTool,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";
import { persistQuery } from "./queryPersistence.ts";
import { request } from "../rpc/client.ts";

const unconfiguredSourceMessage = new RequirementIssueError({
  operation: "resolve",
  reason: "invalid-target",
}).message;

const retainFailedIssueGroups = Effect.fn("sourceControl.retainFailedIssueGroups")(function* (
  result: typeof RequirementIssueListResult.Type,
  previous: Option.Option<typeof RequirementIssueListResult.Type>,
) {
  if (Option.isNone(previous) || result.failures.length === 0) return result;
  const failedProjects = new Set(
    result.failures
      .filter((failure) => failure.reason !== unconfiguredSourceMessage)
      .map((failure) => failure.projectId),
  );
  const sourceKey = (source: (typeof result.groups)[number]["source"]) =>
    JSON.stringify([source.provider, source.host, source.scope]);
  const freshSources = new Set(result.groups.map((group) => sourceKey(group.source)));
  const candidates = previous.value.groups.filter(
    (group) =>
      !freshSources.has(sourceKey(group.source)) &&
      group.projectIds.some((id) => failedProjects.has(id)),
  );
  if (!candidates.length) return result;
  const projectIds = [...new Set(candidates.flatMap((group) => group.projectIds))];
  const sources = yield* Effect.forEach(
    Array.chunksOf(projectIds, 500),
    (projectIds) => request(WS_METHODS.issuesSources, { projectIds }),
    { concurrency: 2 },
  ).pipe(
    Effect.map(Array.flatten),
    Effect.orElseSucceed(() => null),
  );
  const byProject = new Map(sources?.map((project) => [project.projectId, project]));
  const saved = candidates.flatMap((group) => {
    const projectIds = group.projectIds.filter((id) => {
      if (sources === null) return true;
      const project = byProject.get(id);
      return (
        project !== undefined &&
        (project.sources.some((source) => sourceKey(source) === sourceKey(group.source)) ||
          (project.error !== undefined && project.error !== unconfiguredSourceMessage))
      );
    });
    return projectIds.length ? [{ ...group, projectIds }] : [];
  });
  return saved.length ? { ...result, groups: [...result.groups, ...saved] } : result;
});

export function sourceControlToolStatus(tool: SourceControlTool): string {
  switch (tool.phase) {
    case "running":
      return tool.version ? "Updating tool..." : "Installing tool...";
    case "verifying":
      return "Verifying active executable...";
    case "succeeded":
      return "Installation verified.";
    case "unchanged":
      return tool.message ?? "The version is unchanged.";
    case "failed":
      return tool.message ?? "Installation failed.";
    case "idle":
      return tool.status === "unknown"
        ? "Inspection failed."
        : tool.reason
          ? "Manual maintenance"
          : tool.status === "installed"
            ? "Installed"
            : "Not installed";
  }
}

export function createSourceControlEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const issueRefresh = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));
  const issueSources = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issues:sources",
    tag: WS_METHODS.issuesSources,
  });
  return {
    issueSources,
    tools: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:source-control:tools",
      tag: WS_METHODS.sourceControlToolsSubscribe,
    }),
    refreshTools: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:tools-refresh",
      tag: WS_METHODS.sourceControlToolsRefresh,
    }),
    startTool: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:tool-start",
      tag: WS_METHODS.sourceControlToolStart,
    }),
    refreshIssueSources: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:refresh-sources",
      tag: WS_METHODS.issuesSources,
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.update(issueRefresh(environmentId), (value) => value + 1);
          for (const projectId of input.projectIds)
            registry.refresh(issueSources({ environmentId, input: { projectIds: [projectId] } }));
        }),
    }),
    issues: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:list",
      tag: WS_METHODS.requirementIssuesList,
      persistence: persistQuery(RequirementIssueListResult),
      execute: (input, _emit, previous) =>
        request(WS_METHODS.requirementIssuesList, input).pipe(
          Effect.flatMap((result) => retainFailedIssueGroups(result, previous)),
        ),
      refreshTrigger: ({ environmentId }) => issueRefresh(environmentId),
    }),
    issueBranches: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:branches",
      tag: WS_METHODS.issueBranches,
      refreshTrigger: ({ environmentId }) => issueRefresh(environmentId),
    }),
    issueDetail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:detail",
      tag: WS_METHODS.issuesRead,
      refreshTrigger: ({ environmentId }) => issueRefresh(environmentId),
    }),
    issuePeople: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:people",
      tag: WS_METHODS.issuesPeople,
    }),
    issueMetadata: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:metadata",
      tag: WS_METHODS.issuesMetadata,
    }),
    createIssue: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:create",
      tag: WS_METHODS.requirementIssuesCreate,
      scheduler: commandScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.update(issueRefresh(environmentId), (value) => value + 1)),
    }),
    setIssueState: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:set-state",
      tag: WS_METHODS.requirementIssuesSetState,
      scheduler: commandScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.update(issueRefresh(environmentId), (value) => value + 1)),
    }),
    branchIssues: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:branch-issues",
      tag: WS_METHODS.branchIssuesList,
      refreshTrigger: ({ environmentId }) => issueRefresh(environmentId),
    }),
    branchIssueDetail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:branch-issue-detail",
      tag: WS_METHODS.branchIssuesRead,
    }),
    updateBranchIssues: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:update-branch-issues",
      tag: WS_METHODS.branchIssuesUpdate,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.update(issueRefresh(environmentId), (value) => value + 1)),
    }),
    exportProjectConfigurations: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:export-configuration",
      tag: WS_METHODS.projectsExportConfiguration,
    }),
    importProjectConfigurations: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:import-configuration",
      tag: WS_METHODS.projectsImportConfiguration,
    }),
    retryProjectImport: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:retry-import",
      tag: WS_METHODS.projectsRetryImport,
    }),
    forgetProjectImport: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:forget-import",
      tag: WS_METHODS.projectsForgetImport,
    }),
    projectImports: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:projects:imports",
      tag: WS_METHODS.subscribeProjectImports,
    }),
    discovery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:source-control-discovery",
      tag: WS_METHODS.serverDiscoverSourceControl,
    }),
    appAccess: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:app-access",
      tag: WS_METHODS.sourceControlAppAccess,
    }),
    // One check, as after cloning, where no view keeps the query mounted.
    checkAppAccess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:check-app-access",
      tag: WS_METHODS.sourceControlAppAccess,
    }),
    checkStarred: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:check-starred",
      tag: WS_METHODS.sourceControlStarred,
    }),
    star: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:star",
      tag: WS_METHODS.sourceControlStar,
    }),
    repository: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:repository",
      tag: WS_METHODS.sourceControlLookupRepository,
    }),
    // Clone-backed project creation. The RPC returns once the project exists
    // and the clone runs in the background; `projectClones` carries progress.
    startProjectClone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:project-clone-start",
      tag: WS_METHODS.projectCloneStart,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    // Cancel and retry share the start queue so a double click cannot race
    // two actions against the same clone.
    cancelProjectClone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:project-clone-cancel",
      tag: WS_METHODS.projectCloneCancel,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    retryProjectClone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:project-clone-retry",
      tag: WS_METHODS.projectCloneRetry,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    // Unscheduled: a pending sign-in waits on the user for minutes and must not hold up clones.
    startSignIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:sign-in-start",
      tag: WS_METHODS.sourceControlSignInStart,
    }),
    waitForSignIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:sign-in-wait",
      tag: WS_METHODS.sourceControlSignInWait,
    }),
    cancelSignIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:sign-in-cancel",
      tag: WS_METHODS.sourceControlSignInCancel,
    }),
    projectClones: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:source-control:project-clones",
      tag: WS_METHODS.subscribeProjectClones,
    }),
    publishRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:publish-repository",
      tag: WS_METHODS.sourceControlPublishRepository,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: (target, registry) =>
        invalidateCachedVcsRefs(registry, {
          environmentId: target.environmentId,
          cwd: target.input.cwd,
        }),
    }),
  };
}

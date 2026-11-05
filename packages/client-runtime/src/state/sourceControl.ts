import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";

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

export function createSourceControlEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const issueRefresh = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));
  return {
    issues: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:issues:list",
      tag: WS_METHODS.issuesList,
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
      tag: WS_METHODS.issuesCreate,
      scheduler: commandScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.update(issueRefresh(environmentId), (value) => value + 1)),
    }),
    setIssueState: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:set-state",
      tag: WS_METHODS.issuesSetState,
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

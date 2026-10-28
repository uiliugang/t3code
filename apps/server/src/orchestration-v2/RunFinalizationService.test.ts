import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import { workspaceFixture } from "./testkit/workspaceFixtures.ts";

it.effect.each([false, true])(
  "completes finalization when the post-checkpoint workspace refresh fails (multi-repository: %s)",
  (multiRepository) => {
    const threadId = ThreadId.make("thread_refresh_failure");
    const runId = RunId.make("run_refresh_failure");
    const scopeId = CheckpointScopeId.make("scope_refresh_failure");
    const captured: string[] = [];
    const layer = RunFinalization.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
            execute: () =>
              Effect.sync(() => {
                captured.push("checkpoint");
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getCheckpointContext: () =>
              Effect.succeed({
                runs: [],
                checkpointScopes: [
                  {
                    id: scopeId,
                    runId,
                    kind: "root_run" as const,
                    cwd: "/repo",
                    ...(multiRepository ? { workspace: workspaceFixture() } : {}),
                  },
                ],
                checkpoints: [],
              }),
          }),
          Layer.succeed(RunFinalization.RunFinalizationObserver, {
            refresh: ({ cwd }) =>
              Effect.gen(function* () {
                captured.push(cwd);
                return yield* new RunFinalization.RunFinalizationRefreshError({
                  cwd: "/repo",
                  cause: new Error("Git command timed out"),
                });
              }),
            refreshAfterTurn: () => Effect.void,
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* RunFinalization.RunFinalizationService;
      yield* service.finalize({ threadId, runId, scopeId });
      assert.deepEqual(
        captured,
        multiRepository
          ? ["checkpoint", "/tasks/frontend", "/tasks/backend"]
          : ["checkpoint", "/repo"],
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(
  (
    [
      {
        label: "discovers a new PR for the completed run's branch",
        branch: "feature",
        checkedOut: "feature",
        activeRun: null,
        expected: ["/repo"],
      },
      {
        label: "leaves the default branch's PR cache alone",
        branch: "main",
        checkedOut: "main",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh another thread's checkout",
        branch: "feature",
        checkedOut: "other",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh during a newer active run",
        branch: "feature",
        checkedOut: "feature",
        activeRun: "newer-run",
        expected: [],
      },
      {
        label: "refreshes a secondary repository with a different branch",
        branch: "feature/frontend",
        checkedOut: "feature/backend",
        activeRun: null,
        workspace: workspaceFixture(),
        expected: ["/tasks/backend"],
      },
    ] as const
  ).map((scenario) => [scenario.label, scenario] as const),
)("%s", ([, scenario]) => {
  const refreshed: string[] = [];
  const threadId = ThreadId.make("thread-pr-refresh");
  const runId = RunId.make("completed-run");
  const workspace = "workspace" in scenario ? scenario.workspace : undefined;
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: scenario.checkedOut === "main",
              refName: scenario.checkedOut,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshStatus: () =>
            Effect.die("turn completion must preserve known PRs and lookup backoff"),
          refreshPullRequestStatus: (cwd) =>
            Effect.sync(() => {
              refreshed.push(cwd);
              return null;
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: scenario.branch,
              activeRunId: scenario.activeRun === null ? null : RunId.make(scenario.activeRun),
              ...(workspace === undefined ? {} : { workspace }),
            } as OrchestrationV2ThreadShell),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({ cwd: workspace ? "/tasks/backend" : "/repo", threadId, runId });
    assert.deepEqual(refreshed, [...scenario.expected]);
  }).pipe(Effect.provide(layer));
});

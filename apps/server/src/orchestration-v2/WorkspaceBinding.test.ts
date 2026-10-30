import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, WorkspaceRevisionId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { planWorkspaceBinding } from "./WorkspaceBinding.ts";
import { workspaceFixture, workspaceThreadFixture } from "./testkit/workspaceFixtures.ts";

it("binds the whole revision, rejects stale membership edits, and preserves the previous revision", () => {
  const thread = workspaceThreadFixture();
  const workspace = workspaceFixture();
  const command = {
    type: "thread.workspace.bind" as const,
    commandId: CommandId.make("bind:1"),
    threadId: thread.id,
    expectedWorkspaceRevisionId: null,
    workspace,
  };
  const projection = { thread, runs: [], providerSessions: [], runtimeRequests: [] };
  const bound = Result.getOrThrow(
    planWorkspaceBinding({ command, projection, now: thread.updatedAt }),
  );
  assert.equal(bound.worktreePath, "/tasks/frontend");
  assert.equal(bound.branch, "feature/frontend");
  assert.equal(bound.workspace?.bindings.length, 2);
  assert.isUndefined(thread.workspace);
  const next = workspaceFixture({
    id: WorkspaceRevisionId.make("workspace:2"),
    previousRevisionId: workspace.id,
    bindings: workspace.bindings.map((binding) =>
      binding.alias === "backend" ? { ...binding, executionPath: "/tasks/new-backend" } : binding,
    ),
  });
  const stale = planWorkspaceBinding({
    command: { ...command, workspace: next },
    projection: { ...projection, thread: bound },
    now: bound.updatedAt,
  });
  assert.isTrue(Result.isFailure(stale));
  if (Result.isFailure(stale)) assert.equal(stale.failure.reason, "stale-revision");
  const rebound = Result.getOrThrow(
    planWorkspaceBinding({
      command: { ...command, workspace: next, expectedWorkspaceRevisionId: workspace.id },
      projection: { ...projection, thread: bound },
      now: bound.updatedAt,
    }),
  );
  assert.equal(rebound.workspace?.id, next.id);
  assert.equal(bound.workspace?.bindings[1]?.executionPath, "/tasks/backend");
  const foreign = planWorkspaceBinding({
    command: { ...command, workspace: { ...workspace, projectId: ProjectId.make("other") } },
    projection,
    now: thread.updatedAt,
  });
  assert.isTrue(Result.isFailure(foreign));
  const recovery = {
    ...command,
    restoringFromCleanup: true,
    expectedWorkspaceRevisionId: workspace.id,
    workspace: workspaceFixture({
      ...workspace,
      id: WorkspaceRevisionId.make("workspace:recovered"),
      previousRevisionId: workspace.id,
      bindings: structuredClone(workspace.bindings),
    }),
  };
  const archived = { ...projection, thread: { ...bound, archivedAt: bound.updatedAt } };
  assert.isTrue(
    Result.isSuccess(
      planWorkspaceBinding({
        command: recovery,
        projection: archived,
        now: bound.updatedAt,
      }),
    ),
  );
  assert.isTrue(
    Result.isFailure(
      planWorkspaceBinding({
        command: { ...recovery, workspace: { ...recovery.workspace, bindings: next.bindings } },
        projection: archived,
        now: bound.updatedAt,
      }),
    ),
  );
});

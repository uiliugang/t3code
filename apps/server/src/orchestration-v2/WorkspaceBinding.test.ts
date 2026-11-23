import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WorkspaceRevisionId,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
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

it.effect(
  "refreshes workspaceRevisionId and root checkpoint scope when a queued run drains after a workspace rebind at the same primary cwd",
  () =>
    Effect.gen(function* () {
      const frontendDir = yield* checkpointWorkspace("queued-ws-frontend");
      const backendOneDir = yield* checkpointWorkspace("queued-ws-backend-1");

      const instanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId, model: "gpt-5.1-codex" };
      const adapter = {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
        openSession: () => Effect.die("Worker disabled"),
      } as ProviderAdapter.ProviderAdapterV2["Service"];

      const makeWorkspace = (id: string, previousRevisionId: string | null, backendPath: string) =>
        workspaceFixture({
          id: WorkspaceRevisionId.make(id),
          previousRevisionId:
            previousRevisionId === null ? null : WorkspaceRevisionId.make(previousRevisionId),
          resources: [
            {
              ...workspaceFixture().resources[0]!,
              checkoutRoot: frontendDir,
            },
            {
              ...workspaceFixture().resources[1]!,
              checkoutRoot: backendPath,
            },
          ],
          bindings: [
            {
              ...workspaceFixture().bindings[0]!,
              executionPath: frontendDir,
            },
            {
              ...workspaceFixture().bindings[1]!,
              executionPath: backendPath,
            },
          ],
        });

      const ws1 = makeWorkspace("workspace:1", null, backendOneDir);

      const layerDatabase = SqlitePersistence.layerMemory;
      const layer = Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "queued-workspace-rebind" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { databaseLayer: layerDatabase, runEffectWorker: false },
        ),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("thread:queued-ws");

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:create"),
          threadId,
          projectId: ws1.projectId,
          title: "Queued workspace rebind",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });

        // Start run 1 in defer_start ("preparing") while workspace is being provisioned.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:send-1"),
          threadId,
          messageId: MessageId.make("msg:1"),
          text: "first",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });

        // Queue run 2 while run 1 is still preparing (before thread.workspace.bind!).
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:send-2"),
          threadId,
          messageId: MessageId.make("msg:2"),
          text: "second",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });

        // Provisioning finishes and binds ws1 for run 1, then releases run 1.
        const preparingRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (r) => r.userMessageId === MessageId.make("msg:1"),
        )!;
        yield* orchestrator.dispatch({
          type: "thread.workspace.bind",
          commandId: CommandId.make("cmd:bind-1"),
          threadId,
          preparingRunId: preparingRun.id,
          expectedWorkspaceRevisionId: null,
          workspace: ws1,
        });
        yield* orchestrator.dispatch({
          type: "prepared-run.release",
          commandId: CommandId.make("cmd:release-1"),
          threadId,
          runId: preparingRun.id,
        });

        // Stop run 1 and resume the queue so run 2 drains!
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("cmd:stop"),
          threadId,
        });
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("cmd:resume"),
          threadId,
        });

        const afterDrain = yield* orchestrator.getThreadProjection(threadId);
        const run2 = afterDrain.runs.find((r) => r.userMessageId === MessageId.make("msg:2"))!;
        assert.equal(run2.status, "starting");
        assert.equal(run2.workspaceRevisionId, ws1.id);
        const rootNode = afterDrain.nodes.find((n) => n.id === run2.rootNodeId)!;
        const scope = afterDrain.checkpointScopes.find((s) => s.id === rootNode.checkpointScopeId)!;
        assert.equal(scope.workspace?.id, ws1.id);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

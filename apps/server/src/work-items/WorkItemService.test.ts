import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2Run,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as WorkItems from "./WorkItemService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { threadShellFromProjection } from "../orchestration-v2/ProjectionStore.ts";
import { workspaceThreadFixture } from "../orchestration-v2/testkit/workspaceFixtures.ts";

const projectId = ProjectId.make("project:tasks");
const now = "2026-11-09T01:00:00.000Z";
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
const participant = {
  assignment: "Implement the feature",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
} as const;
const command = (suffix: string) => CommandId.make(`task-test:${suffix}`);

function projection(threadId: ThreadId): OrchestrationV2ThreadProjection {
  const at = DateTime.makeUnsafe(now);
  const thread = {
    ...workspaceThreadFixture(),
    id: threadId,
    projectId,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  };
  const run: OrchestrationV2Run = {
    id: RunId.make(`run:${threadId}`),
    threadId,
    ordinal: 1,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${threadId}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "running",
    requestedAt: at,
    startedAt: at,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  return {
    thread,
    runs: [run],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: at,
  };
}

function setup(events?: Queue.Queue<OrchestrationV2DomainEvent>) {
  const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>();
  const launched: Array<Parameters<ThreadLaunch.ThreadLaunchService["Service"]["launch"]>[0]> = [];
  const stopped: ThreadId[] = [];
  const failures = { shell: false, records: false, launch: false };
  const dependencies = Layer.mergeAll(
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        Effect.gen(function* () {
          const result = yield* Effect.sync(() => {
            const threadId = input.threadId ?? ThreadId.make("missing");
            launched.push(input);
            const current = projections.get(threadId) ?? projection(threadId);
            projections.set(threadId, current);
            return {
              threadId,
              projection: current,
              resumed: launched.some(
                (prior) => prior !== input && prior.commandId === input.commandId,
              ),
            };
          });
          if (failures.launch)
            return yield* new ThreadLaunch.ThreadLaunchError({
              operation: "dispatch-message",
              commandId: input.commandId,
              projectId: input.projectId,
              threadId: result.threadId,
              cause: new Error("Lost launch response"),
            });
          return result;
        }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      streamDomainEvents: events === undefined ? Stream.never : Stream.fromQueue(events),
      getThreadShell: (id) =>
        failures.shell
          ? Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId: id }))
          : Effect.succeed(
              projections.has(id)
                ? threadShellFromProjection(projections.get(id) ?? projection(id))
                : null,
            ),
      getThreadRecords: (id) =>
        failures.records
          ? Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId: id }))
          : Effect.succeed(projections.get(id) ?? projection(id)),
      listProjectThreads: () =>
        Effect.succeed([...projections.values()].map(threadShellFromProjection)),
      interruptThread: (input) =>
        Effect.sync(() => {
          stopped.push(input.threadId);
          const current = projections.get(input.threadId);
          if (current)
            projections.set(input.threadId, {
              ...current,
              runs: current.runs.map((run) => ({
                ...run,
                status: "interrupted",
                completedAt: DateTime.makeUnsafe(now),
              })),
            });
          return { type: "no_active_run" };
        }),
      dispatch: (input) =>
        Effect.sync(() => {
          if (input.type === "thread.stop") {
            stopped.push(input.threadId);
            const current = projections.get(input.threadId);
            if (current)
              projections.set(input.threadId, {
                ...current,
                runs: current.runs.map((run) => ({
                  ...run,
                  status: "interrupted",
                  completedAt: DateTime.makeUnsafe(now),
                })),
              });
          }
          return { sequence: 1, storedEvents: [] };
        }),
      listAppOwnedChildThreadIds: () => Effect.succeed([]),
      stopDelegatedTasks: () => Effect.void,
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (id) =>
        Effect.succeedSome({
          projectId: id,
          title: "Project",
          hasCustomTitle: false,
          workspaceRoot: "/repo",
          defaultModelSelection: modelSelection,
          defaultThreadEnvMode: null,
          autoPull: false,
          faviconPath: null,
          projectIcon: null,
          scripts: [],
          pinnedAt: null,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        }),
    }),
  );
  const layer = WorkItems.layer.pipe(
    Layer.provide(dependencies),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(Sqlite.layerMemory),
  );
  return { layer, projections, launched, stopped, failures, events };
}

const create = (service: WorkItems.WorkItemService["Service"], suffix = "create") =>
  service.mutate({
    type: "create",
    commandId: command(suffix),
    projectId,
    title: "Implement board",
    description: "Keep the original behavior",
    constraints: ["Keep data local"],
    acceptanceCriteria: ["Two agents can run independently"],
    priority: "P1",
    sources: [],
  });

it.effect(
  "deduplicates the same dispatch while permitting parallel agents and stopping only one",
  () => {
    const test = setup();
    return Effect.gen(function* () {
      const service = yield* WorkItems.WorkItemService;
      const sql = yield* SqlClient.SqlClient;
      const { item } = yield* create(service);
      const input = {
        type: "start",
        commandId: command("start"),
        id: item.id,
        specRevision: 1,
        participants: [participant, { ...participant, assignment: "Review the design" }],
      } as const;
      const first = yield* service.mutate(input);
      const retry = yield* service.mutate(input);
      assert.deepEqual(
        retry.item.executions.map((entry) => entry.id),
        first.item.executions.map((entry) => entry.id),
      );
      yield* service.drain();
      assert.equal(test.launched.length, 2);
      const firstExecution = first.item.executions[0];
      const secondExecution = first.item.executions[1];
      assert.ok(firstExecution && secondExecution);
      const stopping = yield* service.mutate({
        type: "stop",
        commandId: command("stop"),
        id: item.id,
        executionId: firstExecution.id,
      });
      assert.equal(
        stopping.item.executions.find((entry) => entry.id === secondExecution.id)?.stopRequested,
        false,
      );
      yield* service.drain();
      assert.deepEqual(test.stopped, [firstExecution.threadId]);
      const final = yield* service.get(item.id);
      assert.equal(
        final.executions.find((entry) => entry.id === firstExecution.id)?.status,
        "cancelled",
      );
      assert.equal(
        final.executions.find((entry) => entry.id === secondExecution.id)?.status,
        "running",
      );
      const events = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM work_item_events WHERE event_type = 'start'`;
      assert.equal(events[0]?.count, 1);
      const conflict = yield* Effect.result(
        service.mutate({ ...input, participants: [participant] }),
      );
      assert.equal(conflict._tag, "Failure");
    }).pipe(Effect.provide(test.layer), Effect.scoped);
  },
);

it.effect(
  "freezes requirements and recovers durable launches with stable command and message identifiers",
  () => {
    const test = setup();
    return Effect.gen(function* () {
      const service = yield* WorkItems.WorkItemService;
      const sql = yield* SqlClient.SqlClient;
      const { item } = yield* create(service);
      const started = yield* service.mutate({
        type: "start",
        commandId: command("start"),
        id: item.id,
        specRevision: 1,
        participants: [participant],
      });
      const execution = started.item.executions[0];
      assert.ok(execution);
      yield* service.mutate({
        type: "update",
        commandId: command("update"),
        id: item.id,
        expectedVersion: started.item.version,
        title: "A changed title",
        description: "A new requirement",
        constraints: [],
        acceptanceCriteria: [],
        priority: "P1",
        sources: [],
      });
      yield* service.drain();
      assert.ok(test.launched[0]?.initialMessage?.text.includes("Keep the original behavior"));
      assert.equal(test.launched[0]?.initialMessage?.text.includes("A new requirement"), false);
      yield* sql`INSERT INTO work_item_outbox (execution_id, work_item_id, effect_type, command_id) VALUES (${execution.id}, ${item.id}, 'launch', ${`work-item:${execution.id}:launch`})`;
      yield* service.drain();
      assert.equal(test.launched.length, 2);
      assert.equal(test.launched[0]?.commandId, test.launched[1]?.commandId);
      assert.equal(
        test.launched[0]?.initialMessage?.messageId,
        test.launched[1]?.initialMessage?.messageId,
      );
      const current = yield* service.get(item.id);
      assert.equal(current.executions.length, 1);
      assert.equal(current.executions[0]?.specRevision, 1);
      assert.equal(current.specRevision, 2);
      const stale = yield* Effect.result(
        service.mutate({
          type: "submit",
          commandId: command("old-submit"),
          id: item.id,
          expectedVersion: current.version,
          specRevision: 1,
          executionIds: [execution.id],
          summary: "Old result",
          artifacts: [],
        }),
      );
      assert.equal(stale._tag, "Failure");
    }).pipe(Effect.provide(test.layer), Effect.scoped);
  },
);

it.effect("holds completion for children and requires explicit current-version review", () => {
  const test = setup();
  return Effect.gen(function* () {
    const service = yield* WorkItems.WorkItemService;
    const { item } = yield* create(service);
    const started = yield* service.mutate({
      type: "start",
      commandId: command("start"),
      id: item.id,
      specRevision: 1,
      participants: [participant],
    });
    yield* service.drain();
    const execution = started.item.executions[0];
    assert.ok(execution);
    const current = test.projections.get(execution.threadId);
    assert.ok(current);
    const approvalNodeId = NodeId.make("approval-owned-root");
    const approval = {
      id: RuntimeRequestId.make("approval-owned"),
      nodeId: approvalNodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "command",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: DateTime.makeUnsafe(now),
      resolvedAt: null,
    } as const;
    const unrelatedApproval = {
      ...approval,
      id: RuntimeRequestId.make("approval-unrelated"),
      nodeId: NodeId.make("unrelated-root"),
      kind: "mcp-elicitation",
    } as const;
    test.projections.set(execution.threadId, {
      ...current,
      runs: current.runs.map((run) => ({ ...run, rootNodeId: approvalNodeId })),
      runtimeRequests: [approval, unrelatedApproval],
    });
    yield* service.drain();
    assert.equal((yield* service.get(item.id)).executions[0]?.status, "waiting");
    test.projections.set(execution.threadId, {
      ...current,
      runs: current.runs.map((run) => ({ ...run, rootNodeId: approvalNodeId })),
      runtimeRequests: [
        { ...approval, status: "resolved", resolvedAt: DateTime.makeUnsafe(now) },
        unrelatedApproval,
      ],
    });
    yield* service.drain();
    assert.equal((yield* service.get(item.id)).executions[0]?.status, "running");
    const child = {
      id: NodeId.make("child"),
      threadId: execution.threadId,
      runId: current.runs[0]?.id ?? null,
      parentNodeId: NodeId.make("parent"),
      origin: "app_owned",
      createdBy: "agent",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: modelSelection.instanceId,
      providerThreadId: null,
      childThreadId: ThreadId.make("child-thread"),
      nativeTaskRef: null,
      prompt: "Review",
      title: null,
      model: null,
      status: "running",
      result: null,
      startedAt: DateTime.makeUnsafe(now),
      completedAt: null,
      updatedAt: DateTime.makeUnsafe(now),
    } as const;
    test.projections.set(execution.threadId, {
      ...current,
      runs: current.runs.map((run) => ({
        ...run,
        status: "completed",
        completedAt: DateTime.makeUnsafe(now),
      })),
      subagents: [child],
    });
    yield* service.drain();
    let task = yield* service.get(item.id);
    assert.equal(task.executions[0]?.status, "waiting");
    assert.equal(task.status, "in_progress");
    const premature = yield* Effect.result(
      service.mutate({
        type: "submit",
        commandId: command("premature"),
        id: task.id,
        expectedVersion: task.version,
        specRevision: 1,
        executionIds: [execution.id],
        summary: "Done",
        artifacts: [],
      }),
    );
    assert.equal(premature._tag, "Failure");
    test.projections.set(execution.threadId, {
      ...current,
      runs: current.runs.map((run) => ({
        ...run,
        status: "completed",
        completedAt: DateTime.makeUnsafe(now),
      })),
      subagents: [{ ...child, status: "completed" }],
    });
    yield* service.drain();
    task = yield* service.get(item.id);
    assert.equal(task.executions[0]?.status, "completed");
    assert.equal(task.status, "in_progress");
    const submitted = yield* service.mutate({
      type: "submit",
      commandId: command("submit"),
      id: task.id,
      expectedVersion: task.version,
      specRevision: 1,
      executionIds: [execution.id],
      summary: "Implemented",
      artifacts: ["src/board.ts"],
    });
    const forbidden = yield* Effect.result(
      service.mutate(
        {
          type: "review",
          commandId: command("agent-accept"),
          id: task.id,
          expectedVersion: submitted.item.version,
          decision: "accept",
          note: "",
        },
        execution.threadId,
      ),
    );
    assert.equal(forbidden._tag, "Failure");
    const accepted = yield* service.mutate({
      type: "review",
      commandId: command("accept"),
      id: task.id,
      expectedVersion: submitted.item.version,
      decision: "accept",
      note: "Verified",
    });
    assert.equal(accepted.item.status, "done");
    const reopened = yield* service.mutate({
      type: "reopen",
      commandId: command("reopen"),
      id: task.id,
      expectedVersion: accepted.item.version,
    });
    assert.equal(reopened.item.status, "todo");
  }).pipe(Effect.provide(test.layer), Effect.scoped);
});

it.effect(
  "keeps discovery dismissals until a new user request and validates agent report ownership",
  () => {
    const test = setup();
    return Effect.gen(function* () {
      const service = yield* WorkItems.WorkItemService;
      const sourceId = ThreadId.make("source");
      test.projections.set(sourceId, projection(sourceId));
      const discovered = yield* service.discover({ projectId });
      assert.equal(discovered.candidates.length, 1);
      assert.equal(
        (yield* service.discover({ projectId, dismissThreadId: sourceId })).candidates.length,
        0,
      );
      assert.equal((yield* service.discover({ projectId })).candidates.length, 0);
      const { item } = yield* create(service);
      const started = yield* service.mutate({
        type: "start",
        commandId: command("start"),
        id: item.id,
        specRevision: 1,
        participants: [participant],
      });
      const execution = started.item.executions[0];
      assert.ok(execution);
      const wrongCaller = yield* Effect.result(
        service.mutate(
          {
            type: "report",
            commandId: command("report"),
            id: item.id,
            executionId: execution.id,
            specRevision: 1,
            summary: "Done",
            artifacts: [],
            submitted: true,
          },
          sourceId,
        ),
      );
      assert.equal(wrongCaller._tag, "Failure");
    }).pipe(Effect.provide(test.layer), Effect.scoped);
  },
);

it.effect(
  "paginates all tasks and keeps a detail subscription addressable after its card moves",
  () => {
    const test = setup();
    return Effect.gen(function* () {
      const service = yield* WorkItems.WorkItemService;
      const first = yield* create(service, "one");
      yield* create(service, "two");
      const page = yield* service.list({ projectId, limit: 1 });
      assert.equal(page.items.length, 1);
      assert.ok(page.nextCursor);
      const next = yield* service.list({ projectId, limit: 1, cursor: page.nextCursor });
      assert.equal(next.items.length, 1);
      assert.notEqual(next.items[0]?.id, page.items[0]?.id);
      const details = yield* service.list({ projectId, id: first.item.id });
      assert.equal(details.items[0]?.id, first.item.id);
      assert.equal(details.item?.id, first.item.id);
      assert.equal("executions" in page.items[0]!, false);
    }).pipe(Effect.provide(test.layer), Effect.scoped);
  },
);

it.effect("retains uncertain launch and stop requests until reads recover", () => {
  const test = setup();
  return Effect.gen(function* () {
    const service = yield* WorkItems.WorkItemService;
    const sql = yield* SqlClient.SqlClient;
    const { item } = yield* create(service);
    test.failures.shell = true;
    test.failures.launch = true;
    const started = yield* service.mutate({
      type: "start",
      commandId: command("uncertain-start"),
      id: item.id,
      specRevision: 1,
      participants: [participant],
    });
    const execution = started.item.executions[0];
    assert.ok(execution);
    yield* service.drain();
    assert.equal((yield* service.get(item.id)).executions[0]?.status, "recovering");
    assert.equal(
      (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM work_item_outbox`)[0]?.count,
      1,
    );
    test.failures.shell = false;
    test.failures.records = true;
    yield* service.drain();
    assert.equal(
      (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM work_item_outbox`)[0]?.count,
      1,
    );
    test.failures.launch = false;
    test.failures.records = false;
    yield* service.drain();
    assert.equal((yield* service.get(item.id)).executions[0]?.status, "running");
    assert.equal(new Set(test.launched.map((request) => request.commandId)).size, 1);
    test.failures.shell = true;
    yield* service.mutate({
      type: "stop",
      commandId: command("uncertain-stop"),
      id: item.id,
      executionId: execution.id,
    });
    yield* service.drain();
    assert.notEqual((yield* service.get(item.id)).executions[0]?.status, "cancelled");
    assert.equal(test.stopped.length, 0);
    assert.equal(
      (yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM work_item_outbox WHERE effect_type = 'stop'`)[0]?.count,
      1,
    );
    test.failures.shell = false;
    yield* service.drain();
    assert.equal((yield* service.get(item.id)).executions[0]?.status, "cancelled");
    assert.deepEqual(test.stopped, [execution.threadId]);
  }).pipe(Effect.provide(test.layer), Effect.scoped);
});

it.effect(
  "retains an external MCP client's permission ceiling until a queued stop executes",
  () => {
    const test = setup();
    return Effect.gen(function* () {
      const service = yield* WorkItems.WorkItemService;
      const sql = yield* SqlClient.SqlClient;
      const { item } = yield* create(service);
      const started = yield* service.mutate({
        type: "start",
        commandId: command("client-limits-start"),
        id: item.id,
        specRevision: 1,
        participants: [participant],
      });
      yield* service.drain();
      const execution = started.item.executions[0];
      assert.ok(execution);
      const current = test.projections.get(execution.threadId);
      assert.ok(current);
      test.projections.set(execution.threadId, {
        ...current,
        thread: { ...current.thread, runtimeMode: "full-access" },
      });
      yield* service.mutate(
        {
          type: "stop",
          commandId: command("client-limits-stop"),
          id: item.id,
          executionId: execution.id,
        },
        undefined,
        { runtimeMode: "approval-required", interactionMode: "default" },
      );
      yield* service.drain();
      assert.deepEqual(test.stopped, []);
      assert.notEqual((yield* service.get(item.id)).executions[0]?.status, "cancelled");
      const rows = yield* sql<{
        caller_thread_id: string | null;
        caller_limits_json: string;
      }>`SELECT caller_thread_id, caller_limits_json FROM work_item_outbox WHERE effect_type = 'stop'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.caller_thread_id, null);
      assert.ok(rows[0]?.caller_limits_json.includes("approval-required"));
    }).pipe(Effect.provide(test.layer), Effect.scoped);
  },
);

it.effect("does not replace a failed execution with a later unrelated successful run", () => {
  const test = setup();
  return Effect.gen(function* () {
    const service = yield* WorkItems.WorkItemService;
    const { item } = yield* create(service);
    yield* service.mutate({
      type: "start",
      commandId: command("start"),
      id: item.id,
      specRevision: 1,
      participants: [participant],
    });
    yield* service.drain();
    const execution = (yield* service.get(item.id)).executions[0];
    assert.ok(execution);
    const current = test.projections.get(execution.threadId);
    const root = current?.runs[0];
    assert.ok(current && root);
    const unrelated = {
      ...root,
      id: RunId.make("unrelated-success"),
      userMessageId: MessageId.make("unrelated-request"),
      ordinal: 2,
      status: "completed",
      completedAt: DateTime.makeUnsafe(now),
    } as const;
    test.projections.set(execution.threadId, {
      ...current,
      runs: [{ ...root, status: "failed", completedAt: DateTime.makeUnsafe(now) }, unrelated],
      turnItems: [
        {
          id: TurnItemId.make("owned-failure"),
          threadId: execution.threadId,
          runId: root.id,
          nodeId: root.rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "failed",
          title: null,
          startedAt: null,
          completedAt: DateTime.makeUnsafe(now),
          updatedAt: DateTime.makeUnsafe(now),
          type: "error",
          failure: {
            class: "validation_error",
            message: "Branch policy requires main.",
            code: null,
            retryable: false,
          },
        },
      ],
      messages: [
        {
          createdBy: "user",
          creationSource: "web",
          id: MessageId.make("unrelated-response"),
          threadId: execution.threadId,
          runId: unrelated.id,
          nodeId: null,
          role: "assistant",
          text: "A successful result for a different request",
          attachments: [],
          streaming: false,
          createdAt: DateTime.makeUnsafe(now),
          updatedAt: DateTime.makeUnsafe(now),
        },
      ],
    });
    yield* service.drain();
    const result = (yield* service.get(item.id)).executions[0];
    assert.equal(result?.status, "failed");
    assert.equal(result?.error, "Branch policy requires main.");
    assert.equal(result?.summary.includes("different request"), false);
  }).pipe(Effect.provide(test.layer), Effect.scoped);
});

it.effect(
  "follows explicit completion wakes while excluding a notification steered into an unrelated run",
  () => {
    const test = setup();
    return Effect.gen(function* () {
      const service = yield* WorkItems.WorkItemService;
      const { item } = yield* create(service);
      yield* service.mutate({
        type: "start",
        commandId: command("start"),
        id: item.id,
        specRevision: 1,
        participants: [participant],
      });
      yield* service.drain();
      const execution = (yield* service.get(item.id)).executions[0];
      assert.ok(execution);
      const current = test.projections.get(execution.threadId);
      const root = current?.runs[0];
      assert.ok(current && root);
      const wake = {
        ...root,
        id: RunId.make("owned-wake"),
        userMessageId: MessageId.make("wake-request"),
        ordinal: 2,
        status: "completed",
        completedAt: DateTime.makeUnsafe(now),
      } as const;
      const unrelated = {
        ...wake,
        id: RunId.make("unrelated-run"),
        userMessageId: MessageId.make("unrelated-request"),
        ordinal: 3,
      };
      const message = {
        createdBy: "agent",
        creationSource: "server",
        threadId: execution.threadId,
        nodeId: null,
        role: "user",
        text: "Completion notification",
        attachments: [],
        streaming: false,
        createdAt: DateTime.makeUnsafe(now),
        updatedAt: DateTime.makeUnsafe(now),
      } as const;
      const completion = { parentRunId: root.id, generation: 1, taskIds: [] };
      test.projections.set(execution.threadId, {
        ...current,
        runs: [
          { ...root, status: "completed", completedAt: DateTime.makeUnsafe(now) },
          wake,
          unrelated,
        ],
        messages: [
          { ...message, id: wake.userMessageId, runId: wake.id, delegatedCompletion: completion },
          {
            ...message,
            createdBy: "user",
            creationSource: "web",
            id: unrelated.userMessageId,
            runId: unrelated.id,
            text: "Unrelated request",
          },
          {
            ...message,
            id: MessageId.make("steered-completion"),
            runId: unrelated.id,
            delegatedCompletion: completion,
          },
          {
            ...message,
            id: MessageId.make("owned-response"),
            runId: wake.id,
            role: "assistant",
            text: "The owned final result",
          },
          {
            ...message,
            id: MessageId.make("unrelated-response"),
            runId: unrelated.id,
            role: "assistant",
            text: "An unrelated final result",
          },
        ],
      });
      yield* service.drain();
      const result = (yield* service.get(item.id)).executions[0];
      assert.equal(result?.status, "completed");
      assert.equal(result?.summary, "The owned final result");
    }).pipe(Effect.provide(test.layer), Effect.scoped);
  },
);

it.effect("retains a stop conflict without interrupting an unrelated active run", () => {
  const test = setup();
  return Effect.gen(function* () {
    const service = yield* WorkItems.WorkItemService;
    const sql = yield* SqlClient.SqlClient;
    const { item } = yield* create(service);
    yield* service.mutate({
      type: "start",
      commandId: command("start"),
      id: item.id,
      specRevision: 1,
      participants: [participant],
    });
    yield* service.drain();
    const execution = (yield* service.get(item.id)).executions[0];
    assert.ok(execution);
    const current = test.projections.get(execution.threadId);
    const root = current?.runs[0];
    assert.ok(current && root);
    const unrelated = {
      ...root,
      id: RunId.make("unrelated-running"),
      userMessageId: MessageId.make("unrelated-user"),
      ordinal: 2,
    };
    test.projections.set(execution.threadId, { ...current, runs: [root, unrelated] });
    yield* service.mutate({
      type: "stop",
      commandId: command("stop"),
      id: item.id,
      executionId: execution.id,
    });
    yield* service.drain();
    assert.equal(test.stopped.length, 0);
    assert.equal(
      test.projections.get(execution.threadId)?.runs.find((run) => run.id === unrelated.id)?.status,
      "running",
    );
    const stopped = (yield* service.get(item.id)).executions[0];
    assert.equal(stopped?.status, "recovering");
    assert.ok(stopped?.error?.includes("unrelated work"));
    assert.equal(
      (yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM work_item_outbox WHERE effect_type = 'stop'`)[0]?.count,
      1,
    );
  }).pipe(Effect.provide(test.layer), Effect.scoped);
});

it.effect(
  "freezes the selected workspace and checkpoint evidence without borrowing a later run's code",
  () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const test = setup(events);
      return yield* Effect.gen(function* () {
        const service = yield* WorkItems.WorkItemService;
        const { item } = yield* create(service);
        yield* service.mutate({
          type: "start",
          commandId: command("start"),
          id: item.id,
          specRevision: 1,
          participants: [participant],
        });
        yield* service.drain();
        const execution = (yield* service.get(item.id)).executions[0];
        assert.ok(execution);
        const current = test.projections.get(execution.threadId);
        const root = current?.runs[0];
        assert.ok(current && root);
        const scopeId = CheckpointScopeId.make("owned-scope");
        test.projections.set(execution.threadId, {
          ...current,
          thread: { ...current.thread, worktreePath: null },
          runs: [
            {
              ...root,
              status: "preparing",
              workspacePreparation: { type: "worktree", baseRef: "main" },
            },
          ],
        });
        yield* service.drain();
        assert.equal((yield* service.get(item.id)).executions[0]?.resolvedWorkspacePath, null);
        test.projections.set(execution.threadId, {
          ...current,
          thread: { ...current.thread, worktreePath: "/work/owned", branch: "feature/owned" },
        });
        yield* service.drain();
        const checkpointId = CheckpointId.make("owned-checkpoint");
        const checkpointRef = CheckpointRef.make("refs/t3/owned-checkpoint");
        const unrelated = {
          ...root,
          id: RunId.make("other-code-run"),
          userMessageId: MessageId.make("other-code-user"),
          ordinal: 2,
          status: "completed",
          completedAt: DateTime.makeUnsafe(now),
        } as const;
        test.projections.set(execution.threadId, {
          ...current,
          runs: [{ ...root, status: "completed", completedAt: DateTime.makeUnsafe(now) }],
        });
        yield* service.drain();
        assert.equal((yield* service.get(item.id)).executions[0]?.status, "completed");
        assert.isNull((yield* service.get(item.id)).executions[0]?.checkpointRef);
        test.projections.set(execution.threadId, {
          ...current,
          thread: {
            ...current.thread,
            worktreePath: "/work/unrelated",
            branch: "feature/unrelated",
          },
          runs: [
            { ...root, status: "completed", completedAt: DateTime.makeUnsafe(now) },
            unrelated,
          ],
          checkpointScopes: [
            {
              id: scopeId,
              threadId: execution.threadId,
              runId: root.id,
              nodeId: NodeId.make("root"),
              parentScopeId: null,
              providerThreadId: null,
              kind: "root_run",
              ordinalWithinParent: 1,
              advancesAppRunCount: true,
              cwd: "/work/owned",
              createdAt: DateTime.makeUnsafe(now),
            },
          ],
          checkpoints: [
            {
              id: checkpointId,
              threadId: execution.threadId,
              scopeId,
              runId: root.id,
              nodeId: NodeId.make("root"),
              parentCheckpointId: null,
              ordinalWithinScope: 1,
              appRunOrdinal: 1,
              ref: checkpointRef,
              status: "ready",
              files: [],
              capturedAt: DateTime.makeUnsafe(now),
            },
            {
              id: CheckpointId.make("unrelated-checkpoint"),
              threadId: execution.threadId,
              scopeId,
              runId: unrelated.id,
              nodeId: NodeId.make("other-node"),
              parentCheckpointId: null,
              ordinalWithinScope: 2,
              appRunOrdinal: 2,
              ref: CheckpointRef.make("refs/t3/unrelated-checkpoint"),
              status: "ready",
              files: [],
              capturedAt: DateTime.makeUnsafe("2026-11-09T02:00:00Z"),
            },
          ],
        });
        const captured = test.projections.get(execution.threadId)?.checkpoints[0];
        assert.ok(captured);
        yield* Queue.offer(events, {
          id: EventId.make("late-checkpoint-event"),
          type: "checkpoint.captured",
          threadId: execution.threadId,
          occurredAt: DateTime.makeUnsafe(now),
          payload: captured,
        });
        const observed = yield* service.subscribeList({ id: item.id }).pipe(
          Stream.filter((result) => result.item?.executions[0]?.checkpointRef === checkpointRef),
          Stream.runHead,
        );
        assert.isTrue(observed._tag === "Some");
        const finished = yield* service.get(item.id);
        assert.equal(finished.executions[0]?.resolvedWorkspacePath, "/work/owned");
        assert.equal(finished.executions[0]?.branch, "feature/owned");
        assert.equal(finished.executions[0]?.checkpointRef, checkpointRef);
        const submitted = yield* service.mutate({
          type: "submit",
          commandId: command("submit-evidence"),
          id: item.id,
          expectedVersion: finished.version,
          specRevision: 1,
          executionIds: [execution.id],
          summary: "Selected the owned delivery",
          artifacts: [],
        });
        assert.equal(
          submitted.item.submission?.executionEvidence?.[0]?.checkpointRef,
          checkpointRef,
        );
        assert.equal(
          submitted.item.submission?.executionEvidence?.[0]?.workspacePath,
          "/work/owned",
        );
        test.projections.set(execution.threadId, {
          ...current,
          thread: {
            ...current.thread,
            worktreePath: "/work/changed-again",
            branch: "another-branch",
          },
        });
        yield* service.drain();
        assert.equal(
          (yield* service.get(item.id)).submission?.executionEvidence?.[0]?.branch,
          "feature/owned",
        );
      }).pipe(Effect.provide(test.layer), Effect.scoped);
    }),
);

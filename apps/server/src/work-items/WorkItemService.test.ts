import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  IssueError,
  type OrchestrationV2Run,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ServerCommand,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as WorkItems from "./WorkItemService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as DeliveryAutomation from "./DeliveryAutomationService.ts";
import * as Issues from "../sourceControl/IssueService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { threadShellFromProjection } from "../orchestration-v2/ProjectionStore.ts";
import { workspaceThreadFixture } from "../orchestration-v2/testkit/workspaceFixtures.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ServerSettings from "../serverSettings.ts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Providers from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

const projectId = ProjectId.make("project:tasks");
const now = "2026-11-09T01:00:00.000Z";
const candidatePreview = "Visible source description. ".repeat(25);
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

function setup(
  events?: Queue.Queue<OrchestrationV2DomainEvent>,
  eventStream?: Stream.Stream<OrchestrationV2DomainEvent>,
) {
  const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>();
  const recordBarriers = new Map<ThreadId, Effect.Effect<void>>();
  const launched: Array<Parameters<ThreadLaunch.ThreadLaunchService["Service"]["launch"]>[0]> = [];
  const stopped: ThreadId[] = [];
  const dispatched = new Map<CommandId, OrchestrationV2ServerCommand>();
  const failures = {
    shell: false,
    records: false,
    launch: false,
    dispatchReply: false,
    unsupported: false,
  };
  const dependencies = Layer.mergeAll(
    Layer.mock(Providers.ProviderInstanceRegistry)({
      getInstance: () =>
        Effect.succeed({
          orchestrationAdapter: {
            getCapabilities: () =>
              Effect.succeed({ runtimePolicy: { supportsReadOnly: !failures.unsupported } }),
          },
        } as unknown as ProviderInstance),
    }),
    Layer.mock(ThreadSearch.ThreadSearch)({
      latestMessagePreview: () => Effect.succeed(candidatePreview.slice(0, 500)),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateWorkItemDraft: () =>
        Effect.succeed({
          title: "Draft",
          description: "Goal",
          constraints: [],
          acceptanceCriteria: ["Observable result"],
        }),
    }),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    }),
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
      streamDomainEvents:
        eventStream ?? (events === undefined ? Stream.never : Stream.fromQueue(events)),
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
          : Effect.succeed(projections.get(id) ?? projection(id)).pipe(
              Effect.tap(() => recordBarriers.get(id) ?? Effect.void),
            ),
      listProjectThreads: (input) =>
        Effect.succeed(
          [...projections.values()]
            .map(threadShellFromProjection)
            .filter(
              (thread) =>
                thread.archivedAt === null &&
                thread.deletedAt === null &&
                (input.projectId === undefined || thread.projectId === input.projectId) &&
                thread.lineage.sideChat !== true &&
                (input.includeSubagents || thread.lineage.relationshipToParent !== "subagent"),
            )
            .map(
              ({
                id,
                projectId,
                title,
                lineage,
                settledOverride,
                settledAt,
                snoozedUntil,
                updatedAt,
              }) => ({
                id,
                projectId,
                title,
                lineage,
                settledOverride,
                settledAt,
                snoozedUntil,
                updatedAt,
              }),
            ),
        ),
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
        Effect.gen(function* () {
          if (dispatched.has(input.commandId)) return { sequence: 1, storedEvents: [] };
          dispatched.set(input.commandId, input);
          if (input.type === "thread.fork") {
            const source = projections.get(input.sourceThreadId)!;
            projections.set(input.targetThreadId, {
              ...projection(input.targetThreadId),
              thread: {
                ...source.thread,
                id: input.targetThreadId,
                lineage: {
                  ...source.thread.lineage,
                  parentThreadId: input.sourceThreadId,
                  relationshipToParent: "fork",
                  sideChat: input.sideChat,
                },
              },
              runs: [],
            });
          }
          if (input.type === "message.dispatch") {
            const current = projections.get(input.threadId)!;
            projections.set(input.threadId, {
              ...current,
              runs: projection(input.threadId).runs.map((run) => ({
                ...run,
                userMessageId: input.messageId,
              })),
            });
            if (failures.dispatchReply)
              return yield* new Orchestrator.OrchestratorProjectionError({
                threadId: input.threadId,
              });
          }
          if (input.type === "thread.stop") {
            const current = projections.get(input.threadId);
            if (
              input.expectedRunIds !== undefined &&
              current?.runs.some((run) => !input.expectedRunIds?.includes(run.id))
            )
              return yield* new Orchestrator.OrchestratorDispatchError({
                commandId: input.commandId,
                commandType: input.type,
                cause: "The thread has work outside this stop request's execution scope.",
              });
            stopped.push(input.threadId);
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
  return {
    layer,
    dependencies,
    projections,
    recordBarriers,
    launched,
    stopped,
    failures,
    events,
    dispatched,
  };
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

it.effect("generates an editable draft without persisting or dispatching a task", () => {
  const { layer, launched } = setup();
  return Effect.gen(function* () {
    const service = yield* WorkItems.WorkItemService;
    const draft = yield* service.generateDraft({ projectId, context: "Goal" });
    assert.equal(draft.title, "Draft");
    assert.deepEqual((yield* service.list({ projectId })).items, []);
    assert.deepEqual(launched, []);
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect(
  "preserves local history and invalidates delivery confirmation when scope changes",
  () => {
    const test = setup();
    return Effect.gen(function* () {
      const service = yield* WorkItems.WorkItemService;
      const { item } = yield* create(service);
      assert.equal(item.delivery, undefined);
      const linked = yield* service.mutate({
        type: "link_issue",
        commandId: command("link"),
        id: item.id,
        expectedVersion: item.version,
        issue: {
          provider: "github",
          repository: "acme/app",
          id: "1",
          url: "https://github.com/acme/app/issues/1",
        },
      });
      const confirmed = yield* service.mutate({
        type: "confirm_scope",
        commandId: command("confirm"),
        id: item.id,
        expectedVersion: linked.item.version,
        scopeRevision: 1,
      });
      const synced = yield* service.recordDelivery(item.id, confirmed.item.version, {
        ...confirmed.item.delivery!,
        syncedRevision: 1,
      });
      const changed = yield* service.mutate({
        type: "delivery_scope",
        commandId: command("scope"),
        id: item.id,
        expectedVersion: synced.version,
        requiredPullRequests: ["https://github.com/acme/app/pull/2"],
        changedServices: [],
      });
      assert.equal(changed.item.delivery?.scope.revision, 2);
      assert.equal(changed.item.delivery?.scope.confirmedRevision, null);
      assert.ok(changed.item.delivery?.evidence.anomaly);
      assert.deepEqual(changed.item.constraints, item.constraints);
      assert.deepEqual((yield* service.get(item.id)).delivery, changed.item.delivery);
      const stale = yield* Effect.result(
        service.mutate({
          type: "confirm_scope",
          commandId: command("stale"),
          id: item.id,
          expectedVersion: changed.item.version,
          scopeRevision: 1,
        }),
      );
      assert.equal(stale._tag, "Failure");
    }).pipe(Effect.provide(test.layer), Effect.scoped);
  },
);

it.effect("leaves reference URLs unassociated until the agent identifies a delivery goal", () =>
  Effect.gen(function* () {
    const consumed = yield* Deferred.make<void>();
    const threadId = ThreadId.make("reference-source");
    const event: OrchestrationV2DomainEvent = {
      id: EventId.make("reference-message"),
      type: "message.updated",
      threadId,
      occurredAt: DateTime.makeUnsafe(now),
      payload: {
        id: MessageId.make("reference-message"),
        threadId,
        runId: null,
        nodeId: null,
        createdBy: "user",
        creationSource: "web",
        role: "user",
        text: "Only explain this background issue; do not implement it: https://github.com/acme/app/issues/42",
        attachments: [],
        streaming: false,
        createdAt: DateTime.makeUnsafe(now),
        updatedAt: DateTime.makeUnsafe(now),
      },
    };
    const test = setup(
      undefined,
      Stream.make(event).pipe(Stream.ensuring(Deferred.succeed(consumed, undefined))),
    );
    test.projections.set(threadId, projection(threadId));
    yield* Effect.gen(function* () {
      const service = yield* WorkItems.WorkItemService;
      yield* Deferred.await(consumed);
      assert.deepEqual((yield* service.list({ threadId })).items, []);
    }).pipe(Effect.provide(test.layer), Effect.scoped);
  }),
);

it.effect("deduplicates issue conversations and preserves explicit unlinking across replay", () => {
  const test = setup();
  const threadId = ThreadId.make("issue-source");
  test.projections.set(threadId, projection(threadId));
  return Effect.gen(function* () {
    const service = yield* WorkItems.WorkItemService;
    const input = {
      projectId,
      threadId,
      title: "Deliver reconnect fix",
      automatic: true,
      issue: {
        provider: "github",
        repository: "acme/app",
        id: "1",
        url: "https://github.com/acme/app/issues/1",
      },
    } as const;
    const first = yield* service.associateIssue(input);
    const repeated = yield* service.associateIssue(input);
    assert.equal(first.id, repeated.id);
    assert.equal(repeated.sources.length, 1);
    assert.equal((yield* service.list({ threadId })).items[0]?.id, first.id);
    assert.equal((yield* service.list({ issueUrl: input.issue.url })).item?.id, first.id);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`WITH RECURSIVE newer(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM newer WHERE n < 101)
      INSERT INTO work_items (id, project_id, updated_at, active_count, item_json)
      SELECT 'newer-' || n, project_id, '2026-11-10T01:00:00.000Z', 0,
        json_remove(json_set(item_json, '$.id', 'newer-' || n), '$.delivery')
      FROM work_items, newer WHERE id = ${first.id}`;
    assert.equal(
      (yield* service.list({ limit: 100 })).items.some((item) => item.id === first.id),
      false,
    );
    const tracked = yield* service.list({ issueUrls: [input.issue.url], limit: 100 });
    assert.deepEqual(
      tracked.items.map((item) => item.id),
      [first.id],
    );
    assert.equal(tracked.nextCursor, null);
    assert.equal(tracked.item, undefined);
    assert.deepEqual(tracked.candidates, []);
    yield* sql`DELETE FROM work_items WHERE id LIKE 'newer-%'`;
    const unlinked = yield* service.mutate({
      type: "unlink_issue_thread",
      commandId: command("unlink"),
      id: first.id,
      expectedVersion: first.version,
      threadId,
    });
    assert.equal(unlinked.item.sources.length, 0);
    assert.equal((yield* service.associateIssue(input)).sources.length, 0);
    assert.equal((yield* service.list({ threadId })).items.length, 0);
    assert.equal((yield* service.associateIssue({ ...input, automatic: false })).sources.length, 1);
    const otherThreadId = ThreadId.make("other-project-source");
    const otherProjectId = ProjectId.make("other-project");
    const other = projection(otherThreadId);
    test.projections.set(otherThreadId, {
      ...other,
      thread: { ...other.thread, projectId: otherProjectId },
    });
    const shared = yield* service.associateIssue({
      ...input,
      projectId: otherProjectId,
      threadId: otherThreadId,
    });
    assert.equal(shared.id, first.id);
    assert.equal(shared.sources.length, 2);
    assert.equal((yield* service.list({ projectId: otherProjectId })).items[0]?.id, first.id);
  }).pipe(Effect.provide(test.layer), Effect.scoped);
});

it.effect(
  "reuses the original issue creation action after a client remount or lost dispatch reply",
  () => {
    const test = setup();
    const threadId = ThreadId.make("create-issue-source");
    test.projections.set(threadId, projection(threadId));
    const source = { provider: "github", host: "github.com", scope: "acme/app" } as const;
    const layer = DeliveryAutomation.layer.pipe(
      Layer.provide(test.dependencies),
      Layer.provide(
        Layer.mock(Issues.IssueService)({
          sources: () =>
            Effect.succeed([
              { projectId, repository: "acme/app", sources: [source], manual: true },
            ]),
        }),
      ),
      Layer.provideMerge(test.layer),
    );
    return Effect.gen(function* () {
      const automation = yield* DeliveryAutomation.DeliveryAutomationService;
      const service = yield* WorkItems.WorkItemService;
      test.failures.unsupported = true;
      const unsupported = yield* Effect.result(
        automation.createIssue({ commandId: command("unsupported"), threadId, source }),
      );
      assert.equal(unsupported._tag, "Failure");
      assert.equal((yield* service.list({ projectId })).items.length, 0);
      test.failures.unsupported = false;
      const ready = test.projections.get(threadId)!;
      for (const blocked of [
        {
          ...ready,
          thread: {
            ...ready.thread,
            lineage: { ...ready.thread.lineage, relationshipToParent: "subagent" as const },
          },
        },
        {
          ...ready,
          thread: {
            ...ready.thread,
            delegatedFrom: {
              environmentId: EnvironmentId.make("remote"),
              threadId: ThreadId.make("remote-parent"),
              title: "Remote parent",
            },
          },
        },
      ]) {
        test.projections.set(threadId, blocked);
        const refused = yield* Effect.result(
          automation.createIssue({ commandId: command("blocked-parent"), threadId, source }),
        );
        assert.equal(refused._tag, "Failure");
        assert.equal((yield* service.list({ projectId })).items.length, 0);
      }
      test.projections.set(threadId, {
        ...ready,
        thread: { ...ready.thread, worktreePath: null },
        runs: ready.runs.map((run) => ({
          ...run,
          status: "preparing",
          workspacePreparation: { type: "worktree", baseRef: "main" },
        })),
      });
      const preparing = yield* Effect.result(
        automation.createIssue({ commandId: command("preparing"), threadId, source }),
      );
      assert.equal(preparing._tag, "Failure");
      assert.equal((yield* service.list({ projectId })).items.length, 0);
      test.projections.set(threadId, ready);
      const first = yield* automation.createIssue({
        commandId: command("create-issue"),
        threadId,
        source,
      });
      assert.equal(first.item.executions[0]?.sideChatOf, threadId);
      test.failures.dispatchReply = true;
      yield* service.drain();
      const repeated = yield* automation.createIssue({
        commandId: command("create-issue-remount"),
        threadId,
        source,
      });
      yield* service.drain();
      assert.equal(first.item.id, repeated.item.id);
      assert.equal(first.item.executions[0]?.id, repeated.item.executions[0]?.id);
      assert.equal((yield* service.get(first.item.id)).executions.length, 1);
      assert.equal(test.launched.length, 0);
      const execution = (yield* service.get(first.item.id)).executions[0]!;
      const sideChat = test.projections.get(execution.threadId)!;
      assert.equal(sideChat.thread.lineage.sideChat, true);
      assert.equal(sideChat.thread.lineage.parentThreadId, threadId);
      assert.equal(
        sideChat.thread.worktreePath,
        test.projections.get(threadId)!.thread.worktreePath,
      );
      assert.equal(sideChat.runs.length, 1);
      assert.equal(sideChat.runs[0]?.id, execution.runId);
      assert.equal(test.projections.get(threadId)!.runs.length, 1);
      assert.equal(
        [...test.dispatched.values()].filter((entry) => entry.type === "message.dispatch").length,
        1,
      );
      const refused = yield* Effect.result(
        automation.createIssue({
          commandId: command("bad-destination"),
          threadId,
          source: { ...source, scope: "other/repo" },
        }),
      );
      assert.equal(refused._tag, "Failure");
    }).pipe(Effect.provide(layer), Effect.scoped);
  },
);

it.effect(
  "authorizes only the assigned side chat and never repeats an uncertain external creation",
  () => {
    const test = setup();
    const threadId = ThreadId.make("issue-action-source");
    test.projections.set(threadId, projection(threadId));
    const source = { provider: "github", host: "github.com", scope: "acme/app" } as const;
    let creates = 0;
    let failure: "outcome-unknown" | "unavailable" | null = "outcome-unknown";
    const layer = DeliveryAutomation.layer.pipe(
      Layer.provide(test.dependencies),
      Layer.provide(
        Layer.mock(Issues.IssueService)({
          sources: () =>
            Effect.succeed([
              { projectId, repository: "acme/app", sources: [source], manual: true },
            ]),
          metadata: () => Effect.succeed({ subtypes: [], fields: [] }),
          read: () =>
            Effect.succeed({
              id: "42",
              url: "https://github.com/acme/app/issues/42",
              title: "Issue",
              body: "",
              bodyFormat: "markdown",
              state: "OPEN",
              stateCategory: "todo",
              type: "REQUIREMENT",
              assignees: [],
              priority: "",
              updatedAt: now,
              transitions: [],
            }),
          create: () =>
            Effect.gen(function* () {
              creates++;
              if (failure) return yield* new IssueError({ operation: "create", reason: failure });
              return {
                id: String(41 + creates),
                url: `https://github.com/acme/app/issues/${41 + creates}`,
                title: "Issue",
                body: "",
                bodyFormat: "markdown",
                state: "OPEN",
                stateCategory: "todo",
                type: "REQUIREMENT",
                assignees: [],
                priority: "",
                updatedAt: now,
                transitions: [],
              };
            }),
        }),
      ),
      Layer.provideMerge(test.layer),
    );
    return Effect.gen(function* () {
      const automation = yield* DeliveryAutomation.DeliveryAutomationService;
      const { item } = yield* automation.createIssue({
        commandId: command("authorized-create"),
        threadId,
        source,
      });
      const sideChatId = item.executions[0]!.threadId;
      const action = {
        operation: "create",
        type: "REQUIREMENT",
        subtype: "",
        title: "Issue",
        body: "From conversation",
        assignees: [],
        fields: {},
      } as const;
      const denied = yield* Effect.result(
        automation.issueAction({ id: item.id, action }, threadId),
      );
      assert.equal(denied._tag, "Failure");
      assert.equal(creates, 0);
      const metadata = yield* automation.issueAction(
        { id: item.id, action: { operation: "metadata", type: "REQUIREMENT", subtype: "" } },
        sideChatId,
      );
      assert.deepEqual(metadata, { subtypes: [], fields: [] });
      const failed = yield* Effect.result(
        automation.issueAction({ id: item.id, action }, sideChatId),
      );
      assert.equal(failed._tag, "Failure");
      failure = null;
      const retry = yield* Effect.result(
        automation.issueAction({ id: item.id, action }, sideChatId),
      );
      assert.equal(retry._tag, "Failure");
      assert.equal(creates, 1);
      const wrongSource = yield* Effect.result(
        automation.issueAction(
          {
            id: item.id,
            action: { operation: "recover", url: "https://github.com/other/app/issues/42" },
          },
          sideChatId,
        ),
      );
      assert.equal(wrongSource._tag, "Failure");
      const recovered = yield* automation.issueAction(
        {
          id: item.id,
          action: { operation: "recover", url: "https://github.com/acme/app/issues/42" },
        },
        sideChatId,
      );
      assert.isTrue("item" in recovered);
      if ("item" in recovered) assert.equal(recovered.item.delivery?.issue.id, "42");
      yield* automation.issueAction({ id: item.id, action }, sideChatId);
      assert.equal(creates, 1);
      const nextId = ThreadId.make("issue-action-next");
      test.projections.set(nextId, projection(nextId));
      const next = yield* automation.createIssue({
        commandId: command("issue-next"),
        threadId: nextId,
        source,
      });
      const nextSideChat = next.item.executions[0]!.threadId;
      failure = "unavailable";
      const unavailable = yield* Effect.result(
        automation.issueAction({ id: next.item.id, action }, nextSideChat),
      );
      assert.equal(unavailable._tag, "Failure");
      failure = null;
      const completed = yield* automation.issueAction({ id: next.item.id, action }, nextSideChat);
      assert.isTrue("item" in completed);
      if ("item" in completed) assert.equal(completed.item.delivery?.issue.id, "44");
      yield* automation.issueAction({ id: next.item.id, action }, nextSideChat);
      assert.equal(creates, 3);
    }).pipe(Effect.provide(layer), Effect.scoped);
  },
);

it.effect("rejects unavailable side chat sources and sources outside the task project", () => {
  const test = setup();
  const otherId = ThreadId.make("other-project");
  const other = projection(otherId);
  test.projections.set(otherId, {
    ...other,
    thread: { ...other.thread, projectId: ProjectId.make("other") },
  });
  return Effect.gen(function* () {
    const service = yield* WorkItems.WorkItemService;
    const { item } = yield* create(service);
    for (const sideChatOf of [ThreadId.make("missing"), otherId]) {
      const refused = yield* Effect.result(
        service.mutate({
          type: "start",
          commandId: command(sideChatOf),
          id: item.id,
          specRevision: 1,
          participants: [{ ...participant, sideChatOf }],
        }),
      );
      assert.equal(refused._tag, "Failure");
    }
    assert.equal((yield* service.get(item.id)).executions.length, 0);
  }).pipe(Effect.provide(test.layer), Effect.scoped);
});

it.effect("allows side chats to report only their own execution through MCP", () => {
  const test = setup();
  const parentId = ThreadId.make("report-source");
  test.projections.set(parentId, projection(parentId));
  const layer = McpHttpServer.layerWorkItemToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(test.dependencies),
    Layer.provide(Layer.mock(DeliveryAutomation.DeliveryAutomationService)({})),
    Layer.provideMerge(test.layer),
  );
  return Effect.gen(function* () {
    const service = yield* WorkItems.WorkItemService;
    const server = yield* McpServer.McpServer;
    const { item } = yield* create(service);
    const started = yield* service.mutate({
      type: "start",
      commandId: command("report-side-chat"),
      id: item.id,
      specRevision: 1,
      participants: [{ ...participant, sideChatOf: parentId }],
    });
    yield* service.drain();
    const execution = started.item.executions[0]!;
    const call = (name: string, callerThreadId: ThreadId, submitted = false) =>
      server
        .callTool({
          name,
          arguments: {
            commandId: command(`${name}:${callerThreadId}`),
            id: item.id,
            executionId: execution.id,
            specRevision: 1,
            summary: "Issue creation progress",
            artifacts: [],
            ...(name === "work_item_report" ? { submitted } : {}),
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("report-environment"),
            requestNamespace: "report-session",
            thread: {
              threadId: callerThreadId,
              providerSessionId: "report-session",
              providerInstanceId: modelSelection.instanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"] as const),
            issuedAt: 0,
          }),
          Effect.provideService(
            McpSchema.McpServerClient,
            McpSchema.McpServerClient.of({
              clientId: 1,
              protocolVersion: "2025-06-18",
              clientCapabilities: {},
              clientInfo: { name: "report-test", version: "1" },
              initializePayload: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "report-test", version: "1" },
              },
              getClient: Effect.die("unused"),
            }),
          ),
        );
    const report = yield* call("work_item_report", execution.threadId);
    assert.notEqual(report.isError, true);
    assert.equal((yield* service.get(item.id)).executions[0]?.summary, "Issue creation progress");
    const submitted = yield* call("work_item_submit", execution.threadId);
    assert.notEqual(submitted.isError, true);
    assert.equal((yield* service.get(item.id)).executions[0]?.submitted, true);
    const foreignId = ThreadId.make("foreign-side-chat");
    const foreign = projection(foreignId);
    test.projections.set(foreignId, {
      ...foreign,
      thread: { ...foreign.thread, lineage: { ...foreign.thread.lineage, sideChat: true } },
    });
    assert.equal((yield* call("work_item_report", foreignId)).isError, true);
    const own = test.projections.get(execution.threadId)!;
    test.projections.set(execution.threadId, {
      ...own,
      runs: own.runs.map((run) => ({ ...run, status: "completed" })),
    });
    assert.equal((yield* call("work_item_report", execution.threadId)).isError, true);
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect(
  "resumes an unfinished issue side chat without replacing its task or creation attempt",
  () => {
    const test = setup();
    const parentId = ThreadId.make("resume-issue-source");
    test.projections.set(parentId, projection(parentId));
    const source = { provider: "github", host: "github.com", scope: "acme/app" } as const;
    const layer = DeliveryAutomation.layer.pipe(
      Layer.provide(test.dependencies),
      Layer.provide(
        Layer.mock(Issues.IssueService)({
          sources: () =>
            Effect.succeed([
              { projectId, repository: "acme/app", sources: [source], manual: true },
            ]),
        }),
      ),
      Layer.provideMerge(test.layer),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(now)));
      const service = yield* WorkItems.WorkItemService;
      const automation = yield* DeliveryAutomation.DeliveryAutomationService;
      const sql = yield* SqlClient.SqlClient;
      const { item } = yield* automation.createIssue({
        commandId: command("resume-issue"),
        threadId: parentId,
        source,
      });
      yield* service.drain();
      const execution = (yield* service.get(item.id)).executions[0]!;
      yield* sql`INSERT INTO work_item_delivery_actions (work_item_id, scope_revision, kind, payload_json) VALUES (${item.id}, 0, 'issue_create_attempt', '{}')`;
      yield* service.mutate({
        type: "stop",
        commandId: command("stop-issue"),
        id: item.id,
        executionId: execution.id,
      });
      yield* service.drain();
      assert.equal((yield* service.get(item.id)).executions[0]?.status, "cancelled");
      const current = test.projections.get(execution.threadId)!;
      const root = current.runs[0]!;
      const continued = {
        ...root,
        id: RunId.make("issue-user-continuation"),
        userMessageId: MessageId.make("issue-continue"),
        ordinal: 2,
        status: "running" as const,
        completedAt: null,
      };
      const message = {
        id: continued.userMessageId,
        threadId: execution.threadId,
        runId: continued.id,
        nodeId: null,
        role: "user" as const,
        text: "Continue the issue task",
        attachments: [],
        streaming: false,
        createdBy: "user" as const,
        creationSource: "web" as const,
        createdAt: DateTime.makeUnsafe(now),
        updatedAt: DateTime.makeUnsafe(now),
      };
      for (const blocked of [
        {
          ...current,
          runs: [...current.runs, continued],
          messages: [{ ...message, createdBy: "agent" as const, creationSource: "mcp" as const }],
        },
        {
          ...current,
          runs: [...current.runs, { ...continued, status: "queued" as const }],
          messages: [message],
        },
        {
          ...current,
          thread: { ...current.thread, lineage: { ...current.thread.lineage, sideChat: false } },
          runs: [...current.runs, continued],
          messages: [message],
        },
      ]) {
        test.projections.set(execution.threadId, blocked);
        yield* service.drain();
        assert.equal((yield* service.get(item.id)).executions[0]?.runId, root.id);
        assert.equal((yield* service.get(item.id)).executions[0]?.status, "cancelled");
      }
      test.projections.set(execution.threadId, {
        ...current,
        runs: [...current.runs, continued],
        messages: [message],
      });
      const refreshRead = yield* Deferred.make<void>();
      const releaseRefresh = yield* Deferred.make<void>();
      test.recordBarriers.set(
        execution.threadId,
        Deferred.succeed(refreshRead, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRefresh)),
        ),
      );
      const refresh = yield* service.drain().pipe(Effect.forkChild);
      yield* Deferred.await(refreshRead);
      const archived = yield* service.mutate({
        type: "archive",
        commandId: command("archive-during-resume"),
        id: item.id,
        expectedVersion: (yield* service.get(item.id)).version,
        archived: true,
      });
      test.recordBarriers.delete(execution.threadId);
      yield* Deferred.succeed(releaseRefresh, undefined);
      yield* Fiber.join(refresh);
      yield* service.drain();
      const archivedExecution = (yield* service.get(item.id)).executions[0]!;
      assert.equal(archivedExecution.runId, root.id);
      assert.equal(archivedExecution.status, "cancelled");
      yield* service.mutate({
        type: "archive",
        commandId: command("restore-before-resume"),
        id: item.id,
        expectedVersion: archived.item.version,
        archived: false,
      });
      yield* service.mutate(
        {
          type: "report",
          commandId: command("report-before-resume-refresh"),
          id: item.id,
          executionId: execution.id,
          specRevision: 1,
          summary: "Continued issue creation",
          artifacts: ["https://example.com/issue-evidence"],
          submitted: true,
        },
        execution.threadId,
      );
      yield* service.drain();
      const resumed = (yield* service.get(item.id)).executions[0]!;
      assert.equal(resumed.id, execution.id);
      assert.equal(resumed.runId, continued.id);
      assert.equal(resumed.status, "running");
      assert.equal(resumed.stopRequested, false);
      assert.equal(resumed.summary, "Continued issue creation");
      assert.equal(resumed.submitted, true);
      assert.deepEqual(resumed.artifacts, ["https://example.com/issue-evidence"]);
      assert.equal(
        (yield* sql`SELECT 1 FROM work_item_delivery_actions WHERE work_item_id = ${item.id} AND kind = 'issue_create_attempt'`)
          .length,
        1,
      );
      yield* service.mutate({
        type: "stop",
        commandId: command("stop-resumed-issue"),
        id: item.id,
        executionId: execution.id,
      });
      yield* service.drain();
      assert.equal((yield* service.get(item.id)).executions[0]?.status, "cancelled");
      assert.equal(test.stopped.length, 2);
      const immediate = {
        ...continued,
        id: RunId.make("issue-immediate-stop"),
        userMessageId: MessageId.make("issue-immediate-request"),
        ordinal: 3,
      };
      const stopped = test.projections.get(execution.threadId)!;
      test.projections.set(execution.threadId, {
        ...stopped,
        runs: [...stopped.runs, immediate],
        messages: [
          ...stopped.messages,
          { ...message, id: immediate.userMessageId, runId: immediate.id },
        ],
      });
      yield* sql`INSERT INTO work_item_outbox (execution_id, work_item_id, effect_type, command_id) VALUES (${execution.id}, ${item.id}, 'stop', 'retained-previous-stop')`;
      test.failures.records = true;
      const unavailableStop = yield* Effect.result(
        service.mutate({
          type: "stop",
          commandId: command("stop-before-resume-refresh"),
          id: item.id,
          executionId: execution.id,
        }),
      );
      assert.equal(unavailableStop._tag, "Failure");
      test.failures.records = false;
      yield* service.mutate({
        type: "stop",
        commandId: command("stop-before-resume-refresh"),
        id: item.id,
        executionId: execution.id,
      });
      yield* service.drain();
      const immediatelyStopped = (yield* service.get(item.id)).executions[0]!;
      assert.equal(immediatelyStopped.runId, immediate.id);
      assert.equal(immediatelyStopped.status, "cancelled");
      assert.equal(test.stopped.length, 3);
      assert.equal(
        (yield* sql`SELECT 1 FROM work_item_outbox WHERE execution_id = ${execution.id} AND effect_type = 'stop'`)
          .length,
        0,
      );
      const finalRun = {
        ...continued,
        id: RunId.make("issue-final-run"),
        userMessageId: MessageId.make("issue-final-request"),
        ordinal: 4,
        status: "completed" as const,
        completedAt: DateTime.makeUnsafe(now),
      };
      test.projections.set(execution.threadId, {
        ...current,
        runs: [
          ...current.runs,
          { ...continued, status: "interrupted", completedAt: DateTime.makeUnsafe(now) },
          { ...immediate, status: "interrupted", completedAt: DateTime.makeUnsafe(now) },
          finalRun,
        ],
        messages: [
          message,
          { ...message, id: finalRun.userMessageId, runId: finalRun.id },
          {
            ...message,
            id: MessageId.make("issue-result"),
            runId: finalRun.id,
            createdBy: "agent",
            creationSource: "provider",
            role: "assistant",
            text: "Recovered the issue",
          },
        ],
      });
      yield* service.mutate({
        type: "link_issue",
        commandId: command("link-before-refresh"),
        id: item.id,
        expectedVersion: (yield* service.get(item.id)).version,
        issue: {
          provider: "github",
          repository: "acme/app",
          id: "42",
          url: "https://github.com/acme/app/issues/42",
        },
      });
      yield* service.drain();
      const completed = (yield* service.get(item.id)).executions[0]!;
      assert.equal(completed.status, "completed");
      assert.equal(completed.runId, finalRun.id);
      assert.equal(completed.summary, "Recovered the issue");
      assert.equal((yield* service.get(item.id)).executions.length, 1);
      const finished = test.projections.get(execution.threadId)!;
      const later = {
        ...finalRun,
        id: RunId.make("post-issue-chat"),
        userMessageId: MessageId.make("post-issue-message"),
        ordinal: 5,
        requestedAt: DateTime.makeUnsafe("2026-11-09T01:00:01.000Z"),
        status: "running" as const,
        completedAt: null,
      };
      test.projections.set(execution.threadId, {
        ...finished,
        runs: [...finished.runs, later],
        messages: [...finished.messages, { ...message, id: later.userMessageId, runId: later.id }],
      });
      yield* service.drain();
      assert.equal((yield* service.get(item.id)).executions[0]?.runId, finalRun.id);
      assert.equal((yield* service.get(item.id)).executions[0]?.status, "completed");
    }).pipe(Effect.provide(layer), Effect.scoped);
  },
);

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
      yield* TestClock.setTime(Date.parse(now));
      const service = yield* WorkItems.WorkItemService;
      const sourceId = ThreadId.make("source");
      const at = DateTime.makeUnsafe(now);
      const source = projection(sourceId);
      const userMessage = {
        createdBy: "user",
        creationSource: "web",
        id: MessageId.make("discovery-request"),
        threadId: sourceId,
        runId: null,
        nodeId: null,
        role: "user",
        text: "Implement the requested behavior",
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
      } as const;
      const current = {
        ...source,
        thread: { ...source.thread, title: "Candidate title", updatedAt: at },
        messages: [userMessage],
        updatedAt: at,
      };
      test.projections.set(sourceId, current);
      const oldId = ThreadId.make("old-source");
      const old = projection(oldId);
      test.projections.set(oldId, {
        ...old,
        thread: { ...old.thread, updatedAt: DateTime.makeUnsafe(Date.parse(now) - 40 * 86400000) },
        updatedAt: DateTime.makeUnsafe(Date.parse(now) - 40 * 86400000),
      });
      const discovered = yield* service.discover({ projectId });
      assert.deepEqual(discovered.candidates, [
        {
          id: sourceId,
          projectId,
          title: "Candidate title",
          description: candidatePreview.slice(0, 500),
          status: "running",
          updatedAt: now,
        },
      ]);
      assert.equal(
        (yield* service.discover({ projectId, dismissThreadId: sourceId })).candidates.length,
        0,
      );
      assert.equal((yield* service.discover({ projectId })).candidates.length, 0);
      const noticeAt = DateTime.makeUnsafe(Date.parse(now) + 1000);
      test.projections.set(sourceId, {
        ...current,
        thread: { ...current.thread, updatedAt: noticeAt },
        messages: [
          userMessage,
          {
            ...userMessage,
            id: MessageId.make("agent-notice"),
            createdBy: "agent",
            creationSource: "server",
            updatedAt: noticeAt,
          },
        ],
        updatedAt: noticeAt,
      });
      assert.deepEqual((yield* service.discover({ projectId })).candidates, []);
      const requestAt = DateTime.makeUnsafe(Date.parse(now) + 2000);
      test.projections.set(sourceId, {
        ...current,
        thread: { ...current.thread, updatedAt: requestAt },
        messages: [
          userMessage,
          { ...userMessage, id: MessageId.make("new-request"), updatedAt: requestAt },
        ],
        runs: current.runs.map((run) => ({ ...run, status: "completed", completedAt: requestAt })),
        updatedAt: requestAt,
      });
      const refreshed = (yield* service.discover({ projectId })).candidates;
      assert.equal(refreshed.length, 1);
      assert.equal(refreshed[0]?.updatedAt, DateTime.formatIso(requestAt));
      assert.equal(refreshed[0]?.status, "completed");
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

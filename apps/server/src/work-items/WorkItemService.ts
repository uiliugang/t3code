import {
  CommandId,
  RuntimeMode,
  ProviderInteractionMode,
  isRuntimeModeAbove,
  MessageId,
  type NodeId,
  type RunId,
  ProjectId,
  ThreadId,
  WorkItem,
  WorkItemError,
  WorkItemCandidate,
  WorkItemExecutionId,
  WorkItemId,
  parseBranchIssueUrl,
  type BranchIssueRef,
  type WorkItemDelivery,
  type WorkItemCommandInput,
  type WorkItemDiscoverInput,
  type WorkItemDiscoverResult,
  type WorkItemExecution,
  type WorkItemListInput,
  type WorkItemListResult,
  type WorkItemMutationResult,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { buildWorkItemPrompt, decideWorkItem, executionIsActive } from "./decide.ts";
import { workItemExecutionScope, WORK_ITEM_UNRELATED_WORK } from "./executionScope.ts";
import { workItemCodeEvidence } from "./codeEvidence.ts";
import { decideDelivery } from "./deliveryDecision.ts";

export class WorkItemService extends Context.Service<
  WorkItemService,
  {
    readonly get: (id: WorkItemId) => Effect.Effect<WorkItem, WorkItemError>;
    readonly list: (input: WorkItemListInput) => Effect.Effect<WorkItemListResult, WorkItemError>;
    readonly subscribeList: (
      input: WorkItemListInput,
    ) => Stream.Stream<WorkItemListResult, WorkItemError>;
    readonly mutate: (
      input: WorkItemCommandInput,
      callerThreadId?: ThreadId,
      callerLimits?: typeof SavedCallerLimits.Type,
    ) => Effect.Effect<WorkItemMutationResult, WorkItemError>;
    readonly discover: (
      input: WorkItemDiscoverInput,
    ) => Effect.Effect<WorkItemDiscoverResult, WorkItemError>;
    readonly drain: () => Effect.Effect<void, WorkItemError>;
    readonly associateIssue: (input: {
      projectId: ProjectId;
      threadId: ThreadId;
      issue: BranchIssueRef;
      title: string;
      automatic?: boolean;
    }) => Effect.Effect<WorkItem, WorkItemError>;
    readonly recordDelivery: (
      id: WorkItemId,
      expectedVersion: number,
      delivery: WorkItemDelivery,
    ) => Effect.Effect<WorkItem, WorkItemError>;
  }
>()("t3/work-items/WorkItemService") {}

const SavedCallerLimits = Schema.Struct({
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
const decodeCallerLimits = Schema.decodeUnknownEffect(Schema.fromJsonString(SavedCallerLimits));
const effectiveCallerLimits = (
  saved: typeof SavedCallerLimits.Type | undefined,
  current: {
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  } | null,
) =>
  saved === undefined
    ? (current ?? undefined)
    : current === null
      ? saved
      : {
          runtimeMode: isRuntimeModeAbove(saved.runtimeMode, current.runtimeMode)
            ? current.runtimeMode
            : saved.runtimeMode,
          interactionMode:
            saved.interactionMode === "plan" || current.interactionMode === "plan"
              ? ("plan" as const)
              : ("default" as const),
        };

const isWorkItemError = Schema.is(WorkItemError);
const persistenceError = (cause: unknown) =>
  isWorkItemError(cause)
    ? cause
    : new WorkItemError({ code: "persistence", message: "Could not access task data.", cause });
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeItem = Schema.encodeEffect(Schema.fromJsonString(WorkItem));
const encodeCandidate = Schema.encodeEffect(Schema.fromJsonString(WorkItemCandidate));
const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkItem));
const decodeCandidate = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkItemCandidate));
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const digest = yield* Digest.Digest;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const scope = yield* Effect.scope;
  const writes = yield* Semaphore.make(1);
  const effects = yield* Semaphore.make(1);
  const changed = yield* PubSub.sliding<void>(1);
  const pending = yield* Queue.sliding<void>(1);
  const changedThreads = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
  const evidenceThreads = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
  const notify = PubSub.publish(changed, undefined).pipe(Effect.asVoid);

  const requireProject = Effect.fn("WorkItemService.requireProject")(function* (id: ProjectId) {
    const project = yield* projects.get(id).pipe(Effect.mapError(persistenceError));
    if (Option.isNone(project) || project.value.deletedAt !== null) {
      return yield* new WorkItemError({
        code: "not_found",
        message: "The task project no longer exists.",
      });
    }
    return project.value;
  });
  const get = Effect.fn("WorkItemService.get")(function* (id: WorkItemId) {
    const rows = yield* sql<{
      item_json: string;
    }>`SELECT item_json FROM work_items WHERE id = ${id}`;
    if (!rows[0])
      return yield* new WorkItemError({ code: "not_found", message: "Task not found." });
    return yield* decodeItem(rows[0].item_json);
  }, Effect.mapError(persistenceError));
  const save = Effect.fn("WorkItemService.save")(function* (
    item: WorkItem,
    eventType: string,
    payload: unknown,
  ) {
    const json = yield* encodeItem(item);
    const eventJson = yield* encodeJson(payload);
    const activeCount = item.executions.filter(executionIsActive).length;
    yield* sql`INSERT INTO work_items (id, project_id, updated_at, active_count, item_json) VALUES (${item.id}, ${item.projectId}, ${item.updatedAt}, ${activeCount}, ${json})
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, active_count = excluded.active_count, item_json = excluded.item_json`;
    yield* sql`INSERT INTO work_item_events (work_item_id, event_type, occurred_at, payload_json)
      VALUES (${item.id}, ${eventType}, ${item.updatedAt}, ${eventJson})`;
  });
  const readItems = Effect.fn("WorkItemService.readItems")(function* (input: WorkItemListInput) {
    const limit = (input.limit ?? 50) + 1;
    const projectFilter =
      input.projectId === undefined
        ? sql`1 = 1`
        : sql`(project_id = ${input.projectId} OR id IN (SELECT work_item_id FROM work_item_issue_projects WHERE project_id = ${input.projectId}))`;
    const issueFilter =
      input.issueUrl === undefined
        ? sql`1 = 1`
        : sql`json_extract(item_json, '$.delivery.issue.url') = ${input.issueUrl}`;
    const attentionFilter = input.attentionOnly
      ? sql`(json_extract(item_json, '$.delivery.evidence.anomaly') IS NOT NULL OR json_extract(item_json, '$.delivery.syncError') IS NOT NULL)`
      : sql`1 = 1`;
    const cursorFilter =
      input.cursor === undefined
        ? sql`1 = 1`
        : sql`(updated_at < ${input.cursor.updatedAt} OR (updated_at = ${input.cursor.updatedAt} AND id < ${input.cursor.id}))`;
    const rows = yield* sql<{
      item_json: string;
    }>`SELECT item_json FROM work_items WHERE ${projectFilter} AND ${issueFilter} AND ${attentionFilter} AND ${cursorFilter} AND ${input.id === undefined ? sql`1 = 1` : sql`id = ${input.id}`} AND ${input.threadId === undefined ? sql`1 = 1` : sql`EXISTS (SELECT 1 FROM json_each(item_json, '$.sources') WHERE json_extract(value, '$.threadId') = ${input.threadId})`} ORDER BY updated_at DESC, id DESC LIMIT ${limit}`;
    return yield* Effect.forEach(rows, (row) => decodeItem(row.item_json));
  }, Effect.mapError(persistenceError));
  const list = Effect.fn("WorkItemService.list")(function* (input: WorkItemListInput) {
    const items = yield* readItems(input);
    const rows =
      input.id !== undefined
        ? []
        : input.projectId === undefined
          ? yield* sql<{
              candidate_json: string;
            }>`SELECT candidate_json FROM work_item_candidates LIMIT 200`
          : yield* sql<{
              candidate_json: string;
            }>`SELECT candidate_json FROM work_item_candidates WHERE project_id = ${input.projectId} LIMIT 200`;
    const candidates = yield* Effect.forEach(rows, (row) => decodeCandidate(row.candidate_json));
    const limit = input.limit ?? 50;
    const page = items.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((item) => ({
        id: item.id,
        projectId: item.projectId,
        title: item.title,
        description: item.description.slice(0, 500),
        specRevision: item.specRevision,
        version: item.version,
        status: item.status,
        priority: item.priority,
        archived: item.archived,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        executionCount: item.executions.length,
        activeExecutionCount: item.executions.filter(executionIsActive).length,
        ...(item.delivery === undefined
          ? {}
          : {
              issue: item.delivery.issue,
              deliverySummary: {
                revision: item.delivery.scope.revision,
                progress: decideDelivery(
                  item.delivery.issue.provider,
                  item.delivery.scope,
                  item.delivery.evidence,
                ).progress,
                mergedPullRequests: item.delivery.scope.requiredPullRequests.filter((url) =>
                  item.delivery?.evidence.pullRequests.some((pr) => pr.url === url && pr.merged),
                ).length,
                requiredPullRequests: item.delivery.scope.requiredPullRequests.length,
                releasedServices: item.delivery.scope.changedServices.filter((service) =>
                  item.delivery?.evidence.releases.some(
                    (release) =>
                      release.completed &&
                      release.appkey === service.appkey &&
                      release.target === service.target &&
                      release.revision === service.revision,
                  ),
                ).length,
                changedServices: item.delivery.scope.changedServices.length,
                synced: item.delivery.syncedRevision === item.delivery.scope.revision,
                error: item.delivery.syncError ?? item.delivery.evidence.anomaly ?? null,
              },
            }),
      })),
      ...((input.id === undefined && input.issueUrl === undefined) || page[0] === undefined
        ? {}
        : { item: page[0] }),
      candidates,
      nextCursor: items.length > limit && last ? { updatedAt: last.updatedAt, id: last.id } : null,
    };
  }, Effect.mapError(persistenceError));
  const updateExecution = Effect.fn("WorkItemService.updateExecution")(function* (
    itemId: WorkItemId,
    executionId: WorkItemExecutionId,
    patch: Partial<
      Pick<
        WorkItemExecution,
        | "runId"
        | "status"
        | "error"
        | "summary"
        | "resolvedWorkspacePath"
        | "branch"
        | "checkpointId"
        | "checkpointRef"
        | "codeEvidenceCapturedAt"
      >
    >,
  ) {
    yield* writes.withPermits(1)(
      sql.withTransaction(
        Effect.gen(function* () {
          const item = yield* get(itemId);
          const current = item.executions.find((entry) => entry.id === executionId);
          if (!current) return;
          const next = { ...current, ...patch };
          if (
            next.runId === current.runId &&
            next.status === current.status &&
            next.error === current.error &&
            next.summary === current.summary &&
            next.resolvedWorkspacePath === current.resolvedWorkspacePath &&
            next.branch === current.branch &&
            next.checkpointId === current.checkpointId &&
            next.checkpointRef === current.checkpointRef &&
            next.codeEvidenceCapturedAt === current.codeEvidenceCapturedAt
          )
            return;
          const now = yield* nowIso;
          const updated = {
            ...item,
            updatedAt: now,
            executions: item.executions.map((entry) =>
              entry.id === executionId ? { ...next, updatedAt: now } : entry,
            ),
          };
          yield* save(updated, "execution.updated", { executionId, ...patch });
        }),
      ),
    );
    yield* notify;
  }, Effect.mapError(persistenceError));

  const refreshExecutions = Effect.fn("WorkItemService.refreshExecutions")(function* (
    threadIds: ReadonlySet<ThreadId>,
    checkpointThreadIds: ReadonlySet<ThreadId>,
  ) {
    const evidenceFilter =
      checkpointThreadIds.size === 0
        ? sql`0 = 1`
        : sql`EXISTS (SELECT 1 FROM json_each(item_json, '$.executions') AS execution WHERE json_extract(execution.value, '$.threadId') IN ${sql.in([...checkpointThreadIds])})`;
    const rows = yield* sql<{
      item_json: string;
    }>`SELECT item_json FROM work_items WHERE active_count > 0 OR ${evidenceFilter}`;
    const items = yield* Effect.forEach(rows, (row) => decodeItem(row.item_json));
    yield* Effect.forEach(
      items,
      (item) =>
        Effect.forEach(
          item.executions.filter(
            (entry) =>
              (executionIsActive(entry) &&
                (threadIds.size === 0 || threadIds.has(entry.threadId))) ||
              checkpointThreadIds.has(entry.threadId),
          ),
          (execution) =>
            Effect.gen(function* () {
              if (execution.runId === null) return;
              const result = yield* Effect.result(
                threads.getThreadRecords(execution.threadId, [
                  "runs",
                  "nodes",
                  "runtimeRequests",
                  "turnItems",
                  "messages",
                  "subagents",
                  "providerThreads",
                  "checkpointScopes",
                  "checkpoints",
                ]),
              );
              if (result._tag === "Failure") {
                if (executionIsActive(execution) && execution.status !== "recovering")
                  yield* updateExecution(item.id, execution.id, { status: "recovering" });
                return;
              }
              const records = result.success;
              const root = records.runs.find((run) => run.id === execution.runId);
              if (!root) {
                if (executionIsActive(execution))
                  yield* updateExecution(item.id, execution.id, { status: "recovering" });
                return;
              }
              const owned = workItemExecutionScope(records, root.id);
              if (!executionIsActive(execution)) {
                yield* updateExecution(
                  item.id,
                  execution.id,
                  workItemCodeEvidence(execution, records, owned.runIds, yield* nowIso),
                );
                return;
              }
              if (execution.stopRequested && owned.unrelatedActive) {
                yield* updateExecution(item.id, execution.id, {
                  status: "recovering",
                  error: WORK_ITEM_UNRELATED_WORK,
                });
                return;
              }
              const progress = delegatedTaskProgress(owned);
              const ownedRootNodeIds = new Set(
                owned.runs.flatMap((run) => (run.rootNodeId === null ? [] : [run.rootNodeId])),
              );
              const ownedNodeIds = new Set([
                ...ownedRootNodeIds,
                ...records.nodes
                  .filter((node) =>
                    node.runId !== null
                      ? owned.runIds.has(node.runId)
                      : ownedRootNodeIds.has(node.rootNodeId),
                  )
                  .map((node) => node.id),
              ]);
              const awaitingInput = records.runtimeRequests.some(
                (request) =>
                  request.status === "pending" &&
                  request.kind !== "dynamic_tool_call" &&
                  ownedNodeIds.has(request.nodeId),
              );
              let status: WorkItemExecution["status"];
              if (
                progress.state !== "result_available" ||
                owned.runs.some((run) => run.status === "queued")
              ) {
                const activeRun = owned.runs.find((run) =>
                  ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
                );
                status = execution.stopRequested
                  ? "stopping"
                  : activeRun?.status === "waiting" ||
                      awaitingInput ||
                      activeRun?.queueHeld === true ||
                      progress.state === "waiting_for_children"
                    ? "waiting"
                    : activeRun?.status === "preparing"
                      ? "preparing"
                      : "running";
              } else {
                const terminal = progress.resultRun ?? root;
                status =
                  execution.stopRequested ||
                  ["cancelled", "interrupted", "rolled_back"].includes(terminal.status)
                    ? "cancelled"
                    : terminal.status === "failed"
                      ? "failed"
                      : "completed";
              }
              const summary =
                execution.summary ||
                (status === "completed"
                  ? (owned.messages
                      .filter(
                        (message) =>
                          message.role === "assistant" &&
                          message.runId === (progress.resultRun?.id ?? root.id),
                      )
                      .at(-1)
                      ?.text.slice(0, 16000) ?? "")
                  : "");
              const evidence = workItemCodeEvidence(
                execution,
                records,
                owned.runIds,
                yield* nowIso,
              );
              yield* updateExecution(item.id, execution.id, {
                status,
                summary,
                error:
                  status === "failed"
                    ? (latestRootProviderFailure(progress.resultRun ?? root, records.turnItems)
                        ?.message ?? "Agent execution failed. Open its conversation for details.")
                    : null,
                ...evidence,
              });
            }),
        ).pipe(Effect.asVoid),
      { concurrency: 4 },
    );
  }, Effect.mapError(persistenceError));

  const runPending = Effect.fn("WorkItemService.drain")(function* () {
    yield* effects.withPermits(1)(
      Effect.gen(function* () {
        const rows = yield* sql<{
          execution_id: string;
          work_item_id: string;
          effect_type: string;
          command_id: string;
          caller_thread_id: string | null;
          caller_limits_json: string | null;
        }>`SELECT * FROM work_item_outbox ORDER BY rowid`;
        yield* Effect.forEach(
          rows,
          (row) =>
            Effect.gen(function* () {
              const item = yield* get(WorkItemId.make(row.work_item_id));
              const execution = item.executions.find((entry) => entry.id === row.execution_id);
              if (!execution) return;
              const savedLimits =
                row.caller_limits_json === null
                  ? undefined
                  : yield* decodeCallerLimits(row.caller_limits_json);
              if (row.effect_type === "launch") {
                if (
                  execution.deliveryRevision !== undefined &&
                  (item.delivery?.scope.revision !== execution.deliveryRevision ||
                    item.delivery.scope.confirmedRevision !== execution.deliveryRevision)
                ) {
                  yield* updateExecution(item.id, execution.id, {
                    status: "cancelled",
                    error: "The delivery scope changed before this automatic action started.",
                  });
                  yield* sql`DELETE FROM work_item_outbox WHERE execution_id = ${execution.id} AND effect_type = 'launch'`;
                  return;
                }
                if (!execution.stopRequested) {
                  const caller =
                    row.caller_thread_id === null
                      ? null
                      : yield* threads.getThreadShell(ThreadId.make(row.caller_thread_id));
                  const result = yield* Effect.result(
                    row.caller_thread_id !== null && caller === null
                      ? Effect.fail(
                          new WorkItemError({
                            code: "invalid_request",
                            message: "The calling agent thread is unavailable.",
                          }),
                        )
                      : launches
                          .launch({
                            commandId: CommandId.make(row.command_id),
                            threadId: execution.threadId,
                            projectId: item.projectId,
                            title: item.title,
                            modelSelection: execution.modelSelection,
                            runtimeMode: execution.runtimeMode,
                            interactionMode: execution.interactionMode,
                            workspaceStrategy: execution.workspaceStrategy,
                            createdBy: caller === null ? "user" : "agent",
                            creationSource: "server",
                            initialMessage: {
                              messageId: MessageId.make(`work-item:${execution.id}`),
                              text: execution.prompt,
                              attachments: [],
                            },
                          })
                          .pipe(
                            Effect.mapError(persistenceError),
                            Effect.provideService(
                              DispatchModeLimit,
                              effectiveCallerLimits(savedLimits, caller),
                            ),
                          ),
                  );
                  if (result._tag === "Success") {
                    const run = result.success.projection.runs.toSorted(
                      (a, b) => a.ordinal - b.ordinal,
                    )[0];
                    yield* updateExecution(item.id, execution.id, {
                      runId: run?.id ?? null,
                      status: "preparing",
                      error: null,
                      ...(run === undefined
                        ? {}
                        : workItemCodeEvidence(
                            execution,
                            result.success.projection,
                            new Set([run.id]),
                            yield* nowIso,
                          )),
                    });
                  } else {
                    const shell = yield* Effect.result(threads.getThreadShell(execution.threadId));
                    if (shell._tag === "Failure") {
                      yield* updateExecution(item.id, execution.id, {
                        status: "recovering",
                        error:
                          "Could not confirm whether this agent started. Its dispatch will be recovered.",
                      });
                      return;
                    }
                    if (shell.success === null) {
                      yield* updateExecution(item.id, execution.id, {
                        status: "failed",
                        error:
                          "Could not start this agent. Check its provider and workspace configuration.",
                      });
                    } else {
                      const recovery = yield* Effect.result(
                        threads.getThreadRecords(execution.threadId, ["runs"]),
                      );
                      const run =
                        recovery._tag === "Success"
                          ? recovery.success.runs.toSorted((a, b) => a.ordinal - b.ordinal)[0]
                          : undefined;
                      yield* updateExecution(item.id, execution.id, {
                        ...(run === undefined ? {} : { runId: run.id }),
                        status: "recovering",
                      });
                      if (run === undefined) return;
                    }
                  }
                }
              } else {
                const shell = yield* Effect.result(threads.getThreadShell(execution.threadId));
                if (shell._tag === "Failure") {
                  yield* updateExecution(item.id, execution.id, {
                    status: "recovering",
                    error:
                      "Could not confirm whether this agent stopped. Its stop request is retained.",
                  });
                  return;
                }
                if (shell.success === null) {
                  yield* updateExecution(item.id, execution.id, { status: "cancelled" });
                } else {
                  const caller =
                    row.caller_thread_id === null
                      ? null
                      : yield* threads.getThreadShell(ThreadId.make(row.caller_thread_id));
                  if (row.caller_thread_id !== null && caller === null) {
                    yield* updateExecution(item.id, execution.id, {
                      status: "recovering",
                      error:
                        "The calling agent thread is unavailable. Stop this execution from the task board.",
                    });
                    return;
                  }
                  const limit = effectiveCallerLimits(savedLimits, caller);
                  let ownershipConflict = false;
                  const stopRuns = new Map<ThreadId, ReadonlyArray<RunId>>();
                  const inspect = Effect.fn("WorkItemService.inspectStopModes")(function* (
                    threadId: ThreadId,
                    ownerTaskId?: NodeId,
                  ): Effect.fn.Return<boolean, WorkItemError> {
                    const target = yield* threads
                      .getThreadShell(threadId)
                      .pipe(Effect.mapError(persistenceError));
                    if (
                      target !== null &&
                      limit !== undefined &&
                      exceededDispatchModeLimit(limit, target) !== undefined
                    )
                      return false;
                    const records = yield* threads
                      .getThreadRecords(threadId, [
                        "runs",
                        "messages",
                        "subagents",
                        "providerThreads",
                      ])
                      .pipe(Effect.mapError(persistenceError));
                    const rootRun =
                      threadId === execution.threadId
                        ? records.runs.find(
                            (run) =>
                              run.id === execution.runId ||
                              (execution.runId === null &&
                                run.userMessageId === `work-item:${execution.id}`),
                          )
                        : (records.runs.find((run) => run.delegatedTaskId === ownerTaskId) ??
                          (records.thread.forkedFrom?.type === "node" &&
                          records.thread.forkedFrom.nodeId === ownerTaskId
                            ? records.runs.toSorted((a, b) => a.ordinal - b.ordinal)[0]
                            : undefined));
                    if (rootRun === undefined && records.runs.length > 0) {
                      ownershipConflict = true;
                      return false;
                    }
                    const owned =
                      rootRun === undefined ? null : workItemExecutionScope(records, rootRun.id);
                    if (
                      owned !== null &&
                      (owned.unrelatedActive ||
                        owned.runs.length !== records.runs.length ||
                        owned.subagents.length !== records.subagents.length)
                    ) {
                      ownershipConflict = true;
                      return false;
                    }
                    stopRuns.set(threadId, owned?.runs.map((run) => run.id) ?? []);
                    const childIds = yield* threads
                      .listAppOwnedChildThreadIds(threadId)
                      .pipe(Effect.mapError(persistenceError));
                    for (const childId of childIds) {
                      const task = owned?.subagents.find(
                        (entry) => entry.childThreadId === childId,
                      );
                      if (!task || !(yield* inspect(childId, task.id))) return false;
                    }
                    return true;
                  });
                  if (!(yield* inspect(execution.threadId))) {
                    yield* updateExecution(item.id, execution.id, {
                      status: "recovering",
                      error: ownershipConflict
                        ? WORK_ITEM_UNRELATED_WORK
                        : "This caller cannot stop agents with broader permissions. Stop this execution from the task board.",
                    });
                    return;
                  }
                  yield* Effect.gen(function* () {
                    const scopeKey = (yield* digest.digestHex(
                      Digest.sha256,
                      new TextEncoder().encode([...stopRuns.values()].flat().toSorted().join(",")),
                    )).slice(0, 16);
                    yield* threads.dispatch({
                      type: "thread.stop",
                      commandId: CommandId.make(`${row.command_id}:thread:${scopeKey}`),
                      threadId: execution.threadId,
                      expectedRunIds: stopRuns.get(execution.threadId) ?? [],
                      stopDelegatedTasks: false,
                      reason: "Stopped from the task board.",
                    });
                    yield* threads.stopDelegatedTasks({
                      threadId: execution.threadId,
                      commandId: CommandId.make(`${row.command_id}:children:${scopeKey}`),
                      expectedRunIdsByThread: stopRuns,
                      reason: "Stopped from the task board.",
                    });
                  }).pipe(Effect.provideService(DispatchModeLimit, limit));
                }
              }
              yield* sql`DELETE FROM work_item_outbox WHERE execution_id = ${row.execution_id} AND effect_type = ${row.effect_type}`;
            }).pipe(
              Effect.catch((cause) =>
                updateExecution(
                  WorkItemId.make(row.work_item_id),
                  WorkItemExecutionId.make(row.execution_id),
                  {
                    status: "recovering",
                    error:
                      "The operation could not be confirmed. Its request is retained for recovery.",
                  },
                ).pipe(
                  Effect.andThen(
                    Effect.logWarning("work-item.effect-failed", {
                      executionId: row.execution_id,
                      cause,
                    }),
                  ),
                ),
              ),
            ),
          { concurrency: 4 },
        );
        const threadIds = yield* Ref.getAndSet(changedThreads, new Set());
        const checkpointThreadIds = yield* Ref.getAndSet(evidenceThreads, new Set());
        yield* refreshExecutions(threadIds, checkpointThreadIds);
        const discoveryProjects = yield* sql<{
          project_id: string;
        }>`SELECT project_id FROM work_item_discovery`;
        yield* Effect.forEach(discoveryProjects, (row) =>
          discover({ projectId: ProjectId.make(row.project_id) }).pipe(
            Effect.ignoreCause({ log: true }),
          ),
        );
      }),
    );
  }, Effect.mapError(persistenceError));

  const discover = Effect.fn("WorkItemService.discover")(function* (input: WorkItemDiscoverInput) {
    yield* requireProject(input.projectId);
    if (input.dismissThreadId !== undefined) {
      const rows = yield* sql<{
        candidate_json: string;
      }>`SELECT candidate_json FROM work_item_candidates WHERE thread_id = ${input.dismissThreadId} AND project_id = ${input.projectId}`;
      if (rows[0]) {
        const candidate = yield* decodeCandidate(rows[0].candidate_json);
        yield* sql`INSERT INTO work_item_ignored (thread_id, source_updated_at) VALUES (${candidate.id}, ${candidate.updatedAt}) ON CONFLICT(thread_id) DO UPDATE SET source_updated_at = excluded.source_updated_at`;
      }
    }
    const allThreads = yield* threads.listProjectThreads({
      projectId: input.projectId,
      includeSubagents: false,
    });
    const cutoff = DateTime.toEpochMillis(yield* DateTime.now) - 30 * 86400000;
    const existingRows = yield* sql<{
      item_json: string;
    }>`SELECT item_json FROM work_items WHERE project_id = ${input.projectId}`;
    const existing = yield* Effect.forEach(existingRows, (row) => decodeItem(row.item_json));
    const bound = new Set(
      existing.flatMap((item) => [
        ...item.sources.map((source) => source.threadId),
        ...item.executions.map((execution) => execution.threadId),
      ]),
    );
    const ignored = new Map(
      (yield* sql<{
        thread_id: string;
        source_updated_at: string;
      }>`SELECT thread_id, source_updated_at FROM work_item_ignored`).map((row) => [
        row.thread_id,
        row.source_updated_at,
      ]),
    );
    const candidates: WorkItemCandidate[] = [];
    for (const thread of allThreads) {
      const sourceAt = DateTime.formatIso(
        thread.latestUserAuthoredMessageAt ?? thread.latestUserMessageAt ?? thread.updatedAt,
      );
      if (
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        bound.has(thread.id) ||
        DateTime.toEpochMillis(thread.updatedAt) < cutoff ||
        ignored.get(thread.id) === sourceAt
      )
        continue;
      candidates.push({
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        description: thread.latestVisibleMessage?.text.slice(0, 500) ?? "",
        status: thread.status,
        updatedAt: sourceAt,
      });
      if (candidates.length >= 200) break;
    }
    yield* writes.withPermits(1)(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT OR IGNORE INTO work_item_discovery (project_id) VALUES (${input.projectId})`;
          yield* sql`DELETE FROM work_item_candidates WHERE project_id = ${input.projectId}`;
          for (const candidate of candidates) {
            const candidateJson = yield* encodeCandidate(candidate);
            yield* sql`INSERT INTO work_item_candidates (thread_id, project_id, candidate_json) VALUES (${candidate.id}, ${candidate.projectId}, ${candidateJson})`;
          }
        }),
      ),
    );
    yield* notify;
    return { candidates };
  }, Effect.mapError(persistenceError));

  const mutate = Effect.fn("WorkItemService.mutate")(function* (
    input: WorkItemCommandInput,
    callerThreadId?: ThreadId,
    callerLimits?: typeof SavedCallerLimits.Type,
  ) {
    const result = yield* writes
      .withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            const inputJson = yield* encodeJson({ input, callerThreadId, callerLimits });
            const savedLimitsJson =
              callerLimits === undefined ? null : yield* encodeJson(callerLimits);
            const prior = yield* sql<{
              input_json: string;
              result_json: string;
            }>`SELECT input_json, result_json FROM work_item_commands WHERE command_id = ${input.commandId}`;
            if (prior[0]) {
              if (prior[0].input_json !== inputJson)
                return yield* new WorkItemError({
                  code: "conflict",
                  message: "This command identifier was already used for another request.",
                });
              return { item: yield* decodeItem(prior[0].result_json) };
            }
            if (
              callerThreadId !== undefined &&
              [
                "submit",
                "review",
                "reopen",
                "archive",
                "move",
                "completion_state",
                "reopen_delivery",
                "unlink_issue_thread",
              ].includes(input.type)
            ) {
              return yield* new WorkItemError({
                code: "invalid_request",
                message: "This action requires the task owner's client.",
              });
            }
            const now = yield* nowIso;
            let next: WorkItem;
            if (input.type === "create") {
              yield* requireProject(input.projectId);
              next = {
                id: WorkItemId.make(yield* randomUuidV4),
                projectId: input.projectId,
                title: input.title,
                description: input.description,
                constraints: input.constraints,
                acceptanceCriteria: input.acceptanceCriteria,
                priority: input.priority,
                specRevision: 1,
                version: 1,
                status: "todo",
                archived: false,
                sources: input.sources,
                executions: [],
                submission: null,
                acceptedAt: null,
                createdAt: now,
                updatedAt: now,
              };
            } else {
              const item = yield* get(input.id);
              yield* requireProject(item.projectId);
              if (
                input.type === "report" &&
                callerThreadId !== undefined &&
                !item.executions.some(
                  (execution) =>
                    execution.id === input.executionId && execution.threadId === callerThreadId,
                )
              ) {
                return yield* new WorkItemError({
                  code: "invalid_request",
                  message: "An agent can only report its own task execution.",
                });
              }
              const executions: WorkItemExecution[] = [];
              if (input.type === "start") {
                if (item.executions.length + input.participants.length > 100)
                  return yield* new WorkItemError({
                    code: "invalid_request",
                    message:
                      "This task already has the maximum of 100 executions. Create a follow-up task.",
                  });
                for (const participant of input.participants)
                  executions.push({
                    id: WorkItemExecutionId.make(yield* randomUuidV4),
                    workItemId: item.id,
                    threadId: ThreadId.make(yield* randomUuidV4),
                    runId: null,
                    ...participant,
                    prompt: "",
                    specRevision: item.specRevision,
                    ...(input.deliveryRevision === undefined
                      ? {}
                      : { deliveryRevision: input.deliveryRevision }),
                    specSnapshot: {
                      description: item.description,
                      constraints: item.constraints,
                      acceptanceCriteria: item.acceptanceCriteria,
                    },
                    status: "queued",
                    summary: "",
                    artifacts: [],
                    submitted: false,
                    stopRequested: false,
                    error: null,
                    createdAt: now,
                    updatedAt: now,
                  });
              }
              const frozenExecutions = executions.map((execution) => ({
                ...execution,
                prompt: buildWorkItemPrompt(item, execution),
              }));
              next = yield* Effect.try({
                try: () =>
                  decideWorkItem({ item, command: input, now, executions: frozenExecutions }),
                catch: persistenceError,
              });
              if (input.type === "start")
                for (const execution of executions) {
                  yield* sql`INSERT INTO work_item_outbox (execution_id, work_item_id, effect_type, command_id, caller_thread_id, caller_limits_json) VALUES (${execution.id}, ${item.id}, 'launch', ${`work-item:${execution.id}:launch`}, ${callerThreadId ?? null}, ${savedLimitsJson})`;
                }
              if (input.type === "stop" || input.type === "delivery_scope")
                for (const execution of next.executions.filter(
                  (entry) =>
                    entry.stopRequested &&
                    executionIsActive(entry) &&
                    (input.type !== "stop" ||
                      input.executionId === undefined ||
                      input.executionId === entry.id),
                )) {
                  yield* sql`INSERT INTO work_item_outbox (execution_id, work_item_id, effect_type, command_id, caller_thread_id, caller_limits_json) VALUES (${execution.id}, ${item.id}, 'stop', ${`work-item:${input.commandId}:${execution.id}:stop`}, ${callerThreadId ?? null}, ${savedLimitsJson}) ON CONFLICT(execution_id, effect_type) DO UPDATE SET command_id = excluded.command_id, caller_thread_id = excluded.caller_thread_id, caller_limits_json = excluded.caller_limits_json`;
                }
            }
            if (input.type === "link_issue") {
              const normalized = parseBranchIssueUrl(input.issue.url);
              if (
                normalized === null ||
                normalized.provider !== input.issue.provider ||
                normalized.repository !== input.issue.repository ||
                normalized.id !== input.issue.id ||
                normalized.url !== input.issue.url
              )
                return yield* new WorkItemError({
                  code: "invalid_request",
                  message: "Use a canonical issue identity.",
                });
              const duplicates = yield* sql<{
                id: string;
              }>`SELECT id FROM work_items WHERE json_extract(item_json, '$.delivery.issue.url') = ${input.issue.url} AND id <> ${next.id}`;
              if (duplicates.length > 0)
                return yield* new WorkItemError({
                  code: "conflict",
                  message: "This issue already has a work item. Use its existing record.",
                });
            }
            if (input.type === "create" || input.type === "update")
              for (const source of input.sources) {
                const sourceThread = yield* threads.getThreadShell(source.threadId);
                const linked =
                  sourceThread && next.delivery
                    ? yield* sql<{
                        project_id: string;
                      }>`SELECT project_id FROM work_item_issue_projects WHERE work_item_id = ${next.id} AND project_id = ${sourceThread.projectId}`
                    : [];
                if (
                  sourceThread === null ||
                  (sourceThread.projectId !== next.projectId && linked.length === 0)
                )
                  return yield* new WorkItemError({
                    code: "invalid_request",
                    message: "Task sources must belong to the same project.",
                  });
              }
            yield* save(next, input.type, {
              command: input,
              item: next,
              actor: callerThreadId === undefined ? "user" : "agent",
            });
            if (
              (input.type === "update" || input.type === "unlink_issue_thread") &&
              next.delivery
            ) {
              const sourceThreads = yield* Effect.forEach(next.sources, (source) =>
                threads.getThreadShell(source.threadId),
              );
              const projectIds = [
                ...new Set([
                  next.projectId,
                  ...sourceThreads.flatMap((thread) => (thread ? [thread.projectId] : [])),
                ]),
              ];
              yield* sql`DELETE FROM work_item_issue_projects WHERE work_item_id = ${next.id}`;
              for (const projectId of projectIds)
                yield* sql`INSERT INTO work_item_issue_projects (work_item_id, project_id) VALUES (${next.id}, ${projectId})`;
            }
            yield* sql`INSERT INTO work_item_commands (command_id, input_json, result_json) VALUES (${input.commandId}, ${inputJson}, ${yield* encodeItem(next)})`;
            if (next.sources.length > 0)
              yield* sql`DELETE FROM work_item_candidates WHERE project_id = ${next.projectId} AND thread_id IN ${sql.in(next.sources.map((source) => source.threadId))}`;
            return { item: next };
          }),
        ),
      )
      .pipe(Effect.mapError(persistenceError));
    yield* notify;
    yield* Queue.offer(pending, undefined);
    return result;
  });

  const associateIssue = Effect.fn("WorkItemService.associateIssue")(function* (input: {
    projectId: ProjectId;
    threadId: ThreadId;
    issue: BranchIssueRef;
    title: string;
    automatic?: boolean;
  }) {
    const result = yield* writes
      .withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            const thread = yield* threads.getThreadShell(input.threadId);
            if (thread === null || thread.projectId !== input.projectId)
              return yield* new WorkItemError({
                code: "invalid_request",
                message: "The issue source must match its conversation project.",
              });
            const normalized = parseBranchIssueUrl(input.issue.url);
            if (normalized === null)
              return yield* new WorkItemError({
                code: "invalid_request",
                message: "Unsupported issue link.",
              });
            const rows = yield* sql<{
              item_json: string;
            }>`SELECT item_json FROM work_items WHERE json_extract(item_json, '$.delivery.issue.url') = ${normalized.url}`;
            const existing = rows[0] ? yield* decodeItem(rows[0].item_json) : undefined;
            if (input.automatic && existing?.delivery?.dismissedThreadIds?.includes(input.threadId))
              return existing;
            if (existing?.sources.some((source) => source.threadId === input.threadId))
              return existing;
            if (existing !== undefined && existing.sources.length >= 32)
              return yield* new WorkItemError({
                code: "invalid_request",
                message: "This issue already has 32 linked conversations.",
              });
            const now = yield* nowIso;
            const next: WorkItem = existing
              ? {
                  ...existing,
                  ...(existing.delivery
                    ? {
                        delivery: {
                          ...existing.delivery,
                          dismissedThreadIds: existing.delivery.dismissedThreadIds?.filter(
                            (id) => id !== input.threadId,
                          ),
                        },
                      }
                    : {}),
                  sources: [...existing.sources, { threadId: input.threadId, title: input.title }],
                  version: existing.version + 1,
                  updatedAt: now,
                }
              : {
                  id: WorkItemId.make(yield* randomUuidV4),
                  projectId: input.projectId,
                  title: input.title.slice(0, 300) || `#${normalized.id}`,
                  description: "",
                  constraints: [],
                  acceptanceCriteria: [],
                  priority: "P2",
                  specRevision: 1,
                  version: 1,
                  status: "todo",
                  archived: false,
                  sources: [{ threadId: input.threadId, title: input.title.slice(0, 300) }],
                  executions: [],
                  submission: null,
                  acceptedAt: null,
                  createdAt: now,
                  updatedAt: now,
                  delivery: {
                    issue: normalized,
                    scope: {
                      revision: 1,
                      confirmedRevision: null,
                      requiredPullRequests: [],
                      changedServices: [],
                    },
                    evidence: { pullRequests: [], releases: [], planIds: [], anomaly: null },
                  },
                };
            yield* save(next, "issue.associated", { threadId: input.threadId, issue: normalized });
            yield* sql`INSERT OR IGNORE INTO work_item_issue_projects (work_item_id, project_id) VALUES (${next.id}, ${input.projectId})`;
            return next;
          }),
        ),
      )
      .pipe(Effect.mapError(persistenceError));
    yield* notify;
    return result;
  });

  const recordDelivery = Effect.fn("WorkItemService.recordDelivery")(function* (
    id: WorkItemId,
    expectedVersion: number,
    delivery: WorkItemDelivery,
  ) {
    const result = yield* writes
      .withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* get(id);
            if (
              current.version !== expectedVersion ||
              current.delivery?.scope.revision !== delivery.scope.revision
            )
              return yield* new WorkItemError({
                code: "conflict",
                message: "The delivery scope changed during synchronization.",
              });
            const next = {
              ...current,
              delivery,
              version: current.version + 1,
              updatedAt: yield* nowIso,
            };
            yield* save(next, "delivery.updated", { delivery });
            return next;
          }),
        ),
      )
      .pipe(Effect.mapError(persistenceError));
    yield* notify;
    return result;
  });

  const subscribeList = (input: WorkItemListInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changed);
        return Stream.concat(
          Stream.fromEffect(list(input)),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list(input))),
        );
      }),
    );
  yield* Stream.fromQueue(pending).pipe(
    Stream.runForEach(() => runPending().pipe(Effect.ignoreCause({ log: true }))),
    Effect.forkIn(scope),
  );
  yield* threads.streamDomainEvents.pipe(
    Stream.filter(
      (event) =>
        [
          "run.created",
          "run.updated",
          "subagent.updated",
          "runtime-request.updated",
          "provider-thread.updated",
          "checkpoint.captured",
          "thread.deleted",
        ].includes(event.type) ||
        (event.type === "message.updated" &&
          event.payload.role === "user" &&
          !event.payload.streaming),
    ),
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        if (
          event.type === "message.updated" &&
          event.payload.role === "user" &&
          !event.payload.streaming &&
          event.payload.createdBy === "user"
        ) {
          const thread = yield* threads.getThreadShell(event.threadId);
          if (thread !== null) {
            for (const match of event.payload.text.matchAll(/https:\/\/[^\s<>[\]()]+/g)) {
              const issue = parseBranchIssueUrl(match[0]);
              if (issue !== null)
                yield* associateIssue({
                  projectId: thread.projectId,
                  threadId: event.threadId,
                  issue,
                  title: thread.title,
                  automatic: true,
                }).pipe(Effect.ignoreCause({ log: true }));
            }
          }
        }
        yield* Ref.update(changedThreads, (ids) => new Set([...ids, event.threadId]));
      }).pipe(
        Effect.andThen(
          event.type === "checkpoint.captured"
            ? Ref.update(evidenceThreads, (ids) => new Set([...ids, event.threadId]))
            : Effect.void,
        ),
        Effect.andThen(Queue.offer(pending, undefined)),
      ),
    ),
    Effect.ignoreCause({ log: true }),
    Effect.forkIn(scope),
  );
  yield* Queue.offer(pending, undefined);
  return WorkItemService.of({
    get,
    list,
    subscribeList,
    mutate,
    discover,
    drain: runPending,
    associateIssue,
    recordDelivery,
  });
});

export const layer = Layer.effect(WorkItemService, make);

import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

type ExecutionRecords = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "messages" | "subagents" | "providerThreads"
>;

export function workItemExecutionScope(records: ExecutionRecords, rootRunId: RunId) {
  const runIds = new Set<RunId>([rootRunId]);
  const messages = new Map(records.messages.map((message) => [message.id, message]));
  for (const run of records.runs.toSorted((a, b) => a.ordinal - b.ordinal)) {
    const message = messages.get(run.userMessageId);
    const completion =
      message?.createdBy === "agent" && message.creationSource === "server"
        ? message.delegatedCompletion
        : undefined;
    if (
      (run.restartContinuationOfRunId !== undefined &&
        runIds.has(run.restartContinuationOfRunId)) ||
      (run.usageLimitContinuationOfRunId !== undefined &&
        runIds.has(run.usageLimitContinuationOfRunId)) ||
      (completion !== undefined && runIds.has(completion.parentRunId))
    ) {
      runIds.add(run.id);
    }
  }
  const runs = records.runs.filter((run) => runIds.has(run.id));
  const nodeIds = new Set(runs.flatMap((run) => (run.rootNodeId === null ? [] : [run.rootNodeId])));
  const subagents = records.subagents.filter(
    (task) =>
      (task.runId !== null && runIds.has(task.runId)) ||
      (task.runId === null && nodeIds.has(task.parentNodeId)),
  );
  const taskIds = new Set(
    subagents.flatMap((task) => [
      task.id,
      ...(task.nativeTaskRef?.nativeId ? [task.nativeTaskRef.nativeId] : []),
    ]),
  );
  const runOrdinals = new Set(runs.map((run) => run.ordinal));
  const providerThreads = records.providerThreads.map((thread) => ({
    ...thread,
    pendingBackgroundTasks:
      thread.lastRunOrdinal !== null && runOrdinals.has(thread.lastRunOrdinal)
        ? thread.pendingBackgroundTasks
        : (thread.pendingBackgroundTasks ?? []).filter(
            (task) => task.parentTaskId !== undefined && taskIds.has(task.parentTaskId),
          ),
  }));
  const unrelatedActive =
    records.runs.some(
      (run) =>
        !runIds.has(run.id) &&
        ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
    ) ||
    records.subagents.some(
      (task) => !subagents.includes(task) && isOrchestrationV2WorkActive(task.status),
    ) ||
    records.providerThreads.some(
      (thread) =>
        thread.lastRunOrdinal !== null &&
        !runOrdinals.has(thread.lastRunOrdinal) &&
        backgroundWorkHoldsCompletion(
          (thread.pendingBackgroundTasks ?? []).filter(
            (task) => task.parentTaskId === undefined || !taskIds.has(task.parentTaskId),
          ),
        ),
    );
  return {
    runs,
    messages: records.messages.filter(
      (message) => message.runId !== null && runIds.has(message.runId),
    ),
    subagents,
    providerThreads,
    runIds,
    unrelatedActive,
  };
}

export const WORK_ITEM_UNRELATED_WORK =
  "This thread has unrelated work. Stop it from its conversation before stopping this task execution.";

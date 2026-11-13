import type {
  CommandId,
  WorkItem,
  WorkItemCommandInput,
  WorkItemExecution,
  WorkItemExecutionId,
  DeliverySummary,
} from "@t3tools/contracts";

export const DELIVERY_PROGRESS_LABELS = {
  needs_confirmation: "Needs confirmation",
  awaiting_merge: "Awaiting merge",
  awaiting_plan: "Awaiting release plan",
  awaiting_release: "Awaiting release",
  partially_released: "Partially released",
  delivery_complete: "Delivery complete",
  delivery_exception: "Delivery exception",
} satisfies Record<DeliverySummary["progress"], string>;

export const WORK_ITEM_STATUS_LABELS = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
} satisfies Record<WorkItem["status"], string>;

export function workItemExecutionIsActive(execution: WorkItemExecution): boolean {
  return (
    execution.status !== "completed" &&
    execution.status !== "failed" &&
    execution.status !== "cancelled"
  );
}

export function selectWorkItemResultIds(
  item: Pick<WorkItem, "specRevision"> & {
    readonly executions: ReadonlyArray<Pick<WorkItemExecution, "id" | "status" | "specRevision">>;
  },
  selectedIds: ReadonlyArray<WorkItemExecutionId>,
) {
  return selectedIds.filter((id) =>
    item.executions.some(
      (execution) =>
        execution.id === id &&
        execution.specRevision === item.specRevision &&
        execution.status === "completed",
    ),
  );
}

export function buildWorkItemContinuePrompt(item: WorkItem): string {
  const lines = [
    `Continue task: ${item.title}`,
    `Task ID: ${item.id}`,
    `Specification revision: ${item.specRevision}`,
    "",
    "Goal",
    item.description,
  ];
  if (item.constraints.length > 0)
    lines.push("", "Constraints", ...item.constraints.map((line) => `- ${line}`));
  if (item.acceptanceCriteria.length > 0)
    lines.push("", "Acceptance criteria", ...item.acceptanceCriteria.map((line) => `- ${line}`));
  if (item.reviewFeedback) lines.push("", "Previous review feedback", item.reviewFeedback);
  for (const execution of item.executions) {
    if (!execution.summary) continue;
    lines.push(
      "",
      `Previous execution (${execution.status}, revision ${execution.specRevision})`,
      execution.assignment,
      execution.summary,
    );
    lines.push(...execution.artifacts.map((artifact) => `- ${artifact}`));
  }
  if (item.sources.length > 0)
    lines.push(
      "",
      "Sources",
      ...item.sources.map((source) => `- ${source.title} (thread ${source.threadId})`),
    );
  lines.push(
    "",
    "Work against the current specification. Preserve the constraints. Report deliverables and verification, then submit for user acceptance.",
  );
  return lines.join("\n");
}

export function mergeWorkItemPages<Item extends Pick<WorkItem, "id" | "version" | "updatedAt">>(
  pages: ReadonlyArray<{ readonly items: ReadonlyArray<Item> }>,
): ReadonlyArray<Item> {
  const items = new Map<WorkItem["id"], Item>();
  for (const page of pages) {
    for (const item of page.items) {
      const current = items.get(item.id);
      if (
        !current ||
        item.version > current.version ||
        (item.version === current.version && item.updatedAt >= current.updatedAt)
      )
        items.set(item.id, item);
    }
  }
  return [...items.values()];
}

export function prepareWorkItemCommandRetry(
  input: WorkItemCommandInput,
  retryCommands: Map<string, CommandId>,
  intent?: string,
) {
  const { commandId: proposedId, ...payload } = input;
  const key = JSON.stringify({ intent: intent ?? null, payload });
  const commandId = retryCommands.get(key) ?? proposedId;
  retryCommands.set(key, commandId);
  return { key, input: { ...input, commandId } };
}

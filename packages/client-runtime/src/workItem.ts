import type {
  CommandId,
  WorkItem,
  WorkItemCommandInput,
  WorkItemExecution,
  WorkItemExecutionId,
  DeliverySummary,
  IssueProvider,
} from "@t3tools/contracts";

export function deliveryStages(provider: IssueProvider, summary?: DeliverySummary) {
  const confirmed = summary !== undefined && summary.progress !== "needs_confirmation";
  const merged =
    confirmed &&
    summary.requiredPullRequests > 0 &&
    summary.mergedPullRequests === summary.requiredPullRequests;
  const released =
    merged && summary.changedServices > 0 && summary.releasedServices === summary.changedServices;
  const complete = summary?.progress === "delivery_complete" && summary.synced && !summary.error;
  return [
    {
      key: "development",
      label: "Development stage",
      state: merged ? "complete" : "active",
    },
    // Merge evidence does not establish that tests passed.
    { key: "testing", label: "Testing", state: "unknown" },
    { key: "merge", label: "Merge", state: merged ? "complete" : confirmed ? "active" : "pending" },
    {
      key: "release",
      label: "Release",
      state:
        provider === "github" ? "skipped" : released ? "complete" : merged ? "active" : "pending",
    },
    { key: "complete", label: "Complete", state: complete ? "complete" : "pending" },
  ] as const;
}

export const REQUIREMENT_GROUPS = [
  { key: "attention", label: "Needs attention" },
  { key: "active", label: "In progress" },
  { key: "release", label: "Awaiting release" },
  { key: "todo", label: "To do" },
  { key: "done", label: "Completed" },
] as const;
export type RequirementGroup = (typeof REQUIREMENT_GROUPS)[number]["key"];

export function requirementGroup(status: string, summary?: DeliverySummary): RequirementGroup {
  if (
    summary?.error ||
    summary?.progress === "delivery_exception" ||
    summary?.progress === "needs_confirmation"
  )
    return "attention";
  if (summary) {
    if (summary.progress === "delivery_complete") return summary.synced ? "done" : "release";
    if (["awaiting_plan", "awaiting_release", "partially_released"].includes(summary.progress))
      return "release";
    return "active";
  }
  if (status === "done") return "done";
  if (status === "todo") return "todo";
  return "active";
}

export function pullRequestLabel(url: string): string {
  try {
    const path = new URL(url).pathname.split("/").filter(Boolean);
    const marker = path.findIndex((part) => part === "pull" || part === "pulls");
    return marker > 0 && path[marker + 1]
      ? `${path[marker - 1]} #${path[marker + 1]}`
      : new URL(url).pathname;
  } catch {
    return url;
  }
}

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

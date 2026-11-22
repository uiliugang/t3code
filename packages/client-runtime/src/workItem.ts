import type {
  CommandId,
  WorkItem,
  WorkItemCommandInput,
  WorkItemExecution,
  WorkItemExecutionId,
  DeliverySummary,
  IssueActor,
  IssueLabel,
  IssueListSort,
  IssueListState,
  IssueProvider,
  IssueListResult,
  IssueScopeRef,
  IssueState,
  Issue,
  RequirementIssueListResult,
  ProjectId,
  WorkItemSummary,
} from "@t3tools/contracts";
import { translateUi, type UiTranslator } from "@t3tools/shared/uiLocale";

export function deliveryStages(
  provider: IssueProvider,
  summary?: DeliverySummary,
  t: UiTranslator = translateUi.bind(null, "en"),
) {
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
      label: t("Development stage"),
      state: merged ? "complete" : "active",
    },
    // Merge evidence does not establish that tests passed.
    { key: "testing", label: t("Testing"), state: "unknown" },
    {
      key: "merge",
      label: t("Merge"),
      state: merged ? "complete" : confirmed ? "active" : "pending",
    },
    {
      key: "release",
      label: t("Release"),
      state:
        provider === "github" ? "skipped" : released ? "complete" : merged ? "active" : "pending",
    },
    { key: "complete", label: t("Complete"), state: complete ? "complete" : "pending" },
  ] as const;
}

export function requirementGroups(t: UiTranslator) {
  return [
    { key: "attention", label: t("Needs attention") },
    { key: "active", label: t("In progress") },
    { key: "release", label: t("Awaiting release") },
    { key: "todo", label: t("To do") },
    { key: "done", label: t("Completed") },
  ] as const;
}
export type RequirementGroup = ReturnType<typeof requirementGroups>[number]["key"];

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

export type RequirementTracker = IssueProvider | "gitlab" | "linear";
export type TrackerCreateTarget = IssueScopeRef & { provider: "gitlab" | "linear" };
export function trackerCreateTargets(
  result: IssueListResult | null | undefined,
): TrackerCreateTarget[] {
  return (result?.scopes ?? []).flatMap((scope) => {
    const provider = String(scope.tracker);
    return (provider === "gitlab" || provider === "linear") &&
      result?.trackers.some(
        (tracker) =>
          tracker.tracker === scope.tracker &&
          tracker.host === scope.host &&
          tracker.configured &&
          tracker.capabilities?.create,
      )
      ? [{ ...scope, provider }]
      : [];
  });
}
export type RequirementSource = "all" | RequirementTracker | "local";
type LegacyPage = typeof RequirementIssueListResult.Type;
type LegacyGroup = LegacyPage["groups"][number];
export type RequirementBoardIssue = Issue & {
  readonly displayKey?: string | undefined;
  readonly stateInfo?: IssueState | undefined;
  readonly author?: IssueActor | null | undefined;
  readonly assigneeActors?: ReadonlyArray<IssueActor> | undefined;
  readonly labels?: ReadonlyArray<IssueLabel> | undefined;
  readonly commentCount?: number | undefined;
};
export type RequirementBoardPage = Omit<LegacyPage, "groups"> & {
  groups: ReadonlyArray<
    Omit<LegacyGroup, "source" | "issues"> & {
      source: Omit<LegacyGroup["source"], "provider"> & { provider: RequirementTracker };
      issues: ReadonlyArray<RequirementBoardIssue>;
    }
  >;
};
export const requirementTrackerLabel = {
  github: "GitHub",
  gitlab: "GitLab",
  linear: "Linear",
  meituan: "ONES",
} as const;

type RequirementEntryBase = {
  key: string;
  title: string;
  projectId: ProjectId;
  priority: string;
  state: string;
  group: RequirementGroup;
  createdAt?: string | undefined;
  updatedAt: string;
  summary: DeliverySummary | undefined;
};
export type RequirementEntry = RequirementEntryBase &
  (
    | {
        kind: "issue";
        issue: RequirementBoardIssue;
        provider: RequirementTracker;
        scope: string;
        host: string;
      }
    | { kind: "local"; item: WorkItemSummary }
  );

export function compareRequirementEntries(
  left: Pick<RequirementEntryBase, "key" | "createdAt" | "updatedAt">,
  right: Pick<RequirementEntryBase, "key" | "createdAt" | "updatedAt">,
  sort: IssueListSort = "updated",
): number {
  const leftTime = sort === "created" ? (left.createdAt ?? left.updatedAt) : left.updatedAt;
  const rightTime = sort === "created" ? (right.createdAt ?? right.updatedAt) : right.updatedAt;
  return rightTime.localeCompare(leftTime) || left.key.localeCompare(right.key);
}

function matchesIssueStateFilter(closed: boolean, issueState: IssueListState | undefined): boolean {
  if (!issueState || issueState === "all") return true;
  return issueState === "closed" ? closed : !closed;
}

export function mergeRequirementEntries(
  issuePages: ReadonlyArray<RequirementBoardPage>,
  items: ReadonlyArray<WorkItemSummary>,
  tracked: ReadonlyMap<string, WorkItemSummary>,
  options: {
    source?: RequirementSource;
    query?: string;
    archived?: boolean;
    issueState?: IssueListState | undefined;
    sort?: IssueListSort | undefined;
  } = {},
): ReadonlyArray<RequirementEntry> {
  const entries = new Map<string, RequirementEntry>();
  if (!options.archived && options.source !== "local") {
    for (const page of issuePages)
      for (const group of page.groups) {
        if (options.source && options.source !== "all" && options.source !== group.source.provider)
          continue;
        const projectId = group.projectIds[0];
        if (!projectId) continue;
        for (const issue of group.issues) {
          const isClosed = issue.stateInfo
            ? issue.stateInfo.category === "closed"
            : issue.stateCategory === "done";
          if (!matchesIssueStateFilter(isClosed, options.issueState)) continue;
          const summary = tracked.get(issue.url)?.deliverySummary;
          entries.set(issue.url, {
            key: issue.url,
            kind: "issue",
            title: issue.title,
            projectId,
            priority: issue.priority,
            state: issue.state,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt,
            group: requirementGroup(issue.stateCategory, summary),
            summary,
            issue,
            provider: group.source.provider,
            scope: group.source.scope,
            host: group.source.host,
          });
        }
      }
  }
  const query = options.query?.trim().toLowerCase() ?? "";
  for (const item of items) {
    const group = requirementGroup(item.status, item.deliverySummary);
    if (
      (item.issue && entries.has(item.issue.url)) ||
      (options.source &&
        options.source !== "all" &&
        options.source !== (item.issue?.provider ?? "local")) ||
      item.archived !== Boolean(options.archived) ||
      !matchesIssueStateFilter(item.status === "done", options.issueState) ||
      !`${item.title}\n${item.description}`.toLowerCase().includes(query)
    )
      continue;
    entries.set(`local:${item.id}`, {
      key: `local:${item.id}`,
      kind: "local",
      item,
      title: item.title,
      projectId: item.projectId,
      priority: item.priority,
      state: WORK_ITEM_STATUS_LABELS[item.status],
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      group,
      summary: item.deliverySummary,
    });
  }
  return [...entries.values()].sort((a, b) => compareRequirementEntries(a, b, options.sort));
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

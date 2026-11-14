import {
  CommandId,
  ProjectId,
  WorkItemExecutionId,
  WorkItemId,
  type WorkItem,
  type WorkItemCommandInput,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  buildWorkItemContinuePrompt,
  mergeWorkItemPages,
  prepareWorkItemCommandRetry,
  selectWorkItemResultIds,
  deliveryStages,
  requirementGroup,
  mergeRequirementEntries,
} from "./workItem.ts";

it("keeps testing unverified after merge and only completes after a successful platform sync", () => {
  const summary = {
    revision: 1,
    progress: "delivery_complete" as const,
    mergedPullRequests: 2,
    requiredPullRequests: 2,
    releasedServices: 1,
    changedServices: 1,
    synced: false,
    error: null,
  };
  expect(deliveryStages("github", summary).map((stage) => stage.state)).toEqual([
    "complete",
    "unknown",
    "complete",
    "skipped",
    "pending",
  ]);
  expect(requirementGroup("done", summary)).toBe("release");
  expect(requirementGroup("done", { ...summary, synced: true })).toBe("done");
  expect(requirementGroup("done", { ...summary, synced: true, error: "Sync failed" })).toBe(
    "attention",
  );
  expect(
    deliveryStages("meituan", { ...summary, progress: "needs_confirmation" }).find(
      (stage) => stage.key === "merge",
    )?.state,
  ).toBe("pending");
  expect(
    requirementGroup("done", { ...summary, progress: "delivery_exception", synced: true }),
  ).toBe("attention");
});

const task = (patch: Partial<WorkItem> = {}): WorkItem => ({
  id: WorkItemId.make("task"),
  projectId: ProjectId.make("project"),
  title: "Fix login",
  description: "",
  constraints: [],
  acceptanceCriteria: [],
  specRevision: 1,
  version: 1,
  status: "todo",
  priority: "P2",
  archived: false,
  sources: [],
  executions: [],
  submission: null,
  acceptedAt: null,
  createdAt: "2026-11-09T00:00:00.000Z",
  updatedAt: "2026-11-09T00:00:00.000Z",
  ...patch,
});

it("submits only selected successful results for the current specification", () => {
  const current = WorkItemExecutionId.make("current");
  const previous = WorkItemExecutionId.make("previous");
  const failed = WorkItemExecutionId.make("failed");
  const cancelled = WorkItemExecutionId.make("cancelled");
  const running = WorkItemExecutionId.make("running");
  const unselected = WorkItemExecutionId.make("unselected");
  const missing = WorkItemExecutionId.make("missing");
  const selected = [previous, failed, cancelled, running, missing, current];
  const item = {
    specRevision: 2,
    executions: [
      { id: previous, specRevision: 1, status: "completed" },
      { id: current, specRevision: 2, status: "completed" },
      { id: failed, specRevision: 2, status: "failed" },
      { id: cancelled, specRevision: 2, status: "cancelled" },
      { id: running, specRevision: 2, status: "running" },
      { id: unselected, specRevision: 2, status: "completed" },
    ],
  } satisfies Parameters<typeof selectWorkItemResultIds>[0];

  expect(selectWorkItemResultIds(item, selected)).toEqual([current]);
  expect(selectWorkItemResultIds({ ...item, specRevision: 3 }, selected)).toEqual([]);
});

it("keeps the owner's change request in a continuation draft", () => {
  const prompt = buildWorkItemContinuePrompt(
    task({
      specRevision: 2,
      reviewFeedback: "Keep existing credentials and verify remote login.",
    }),
  );
  expect(prompt).toContain("Specification revision: 2");
  expect(prompt).toContain("Keep existing credentials and verify remote login.");
});

it("keeps the newest task when live pages overlap during a move between cursors", () => {
  const previous = task();
  const edited = task({ version: 2, status: "in_progress", updatedAt: "2026-11-09T00:01:00.000Z" });
  const runtimeUpdate = task({
    version: 2,
    status: "in_progress",
    updatedAt: "2026-11-09T00:02:00.000Z",
  });
  const other = task({ id: WorkItemId.make("other") });
  expect(
    mergeWorkItemPages([
      { items: [runtimeUpdate] },
      { items: [previous, other] },
      { items: [edited] },
    ]),
  ).toEqual([runtimeUpdate, other]);
  expect(
    mergeWorkItemPages([
      { items: [previous] },
      { items: [edited] },
      { items: [runtimeUpdate, other] },
    ]),
  ).toEqual([runtimeUpdate, other]);
});

it("reuses a failed dispatch identity but keeps an explicit additional dispatch independent", () => {
  const retryCommands = new Map<string, CommandId>();
  const input: WorkItemCommandInput = {
    type: "create",
    commandId: CommandId.make("first"),
    projectId: ProjectId.make("project"),
    title: "Task",
    description: "",
    constraints: [],
    acceptanceCriteria: [],
    priority: "P2",
    sources: [],
  };
  const original = prepareWorkItemCommandRetry(input, retryCommands, "intent-a");
  const retried = prepareWorkItemCommandRetry(
    { ...input, commandId: CommandId.make("retry") },
    retryCommands,
    "intent-a",
  );
  expect(retried.input.commandId).toBe(original.input.commandId);
  const additional = prepareWorkItemCommandRetry(
    { ...input, commandId: CommandId.make("additional") },
    retryCommands,
    "intent-b",
  );
  expect(additional.input.commandId).toBe("additional");
  retryCommands.delete(original.key);
  const afterSuccess = prepareWorkItemCommandRetry(
    { ...input, commandId: CommandId.make("after-success") },
    retryCommands,
    "intent-a",
  );
  expect(afterSuccess.input.commandId).toBe("after-success");
});

it("merges issue sources and local tasks without duplicating tracked issues", () => {
  const projectId = ProjectId.make("project");
  const local = { ...task(), executionCount: 1, activeExecutionCount: 1 };
  const issue = {
    id: "12",
    url: "https://github.com/org/repo/issues/12",
    title: "External issue",
    state: "Open",
    stateCategory: "todo" as const,
    type: "Issue",
    assignees: [],
    priority: "",
    updatedAt: local.updatedAt,
  };
  const result = {
    groups: [
      {
        source: { provider: "github" as const, host: "github.com", scope: "org/repo" },
        projectIds: [projectId],
        issues: [issue],
        hasMore: false,
      },
    ],
    failures: [],
  };
  const tracked = {
    ...local,
    id: WorkItemId.make("tracked"),
    issue: {
      provider: "github" as const,
      host: "github.com",
      repository: "org/repo",
      number: "12",
      url: issue.url,
    },
  };
  const meituan = {
    groups: [
      {
        ...result.groups[0]!,
        source: { provider: "meituan" as const, host: "mep.sankuai.com", scope: "123" },
        issues: [
          { ...issue, url: "https://mep.sankuai.com/ones/123/12", title: "ONES requirement" },
        ],
      },
    ],
    failures: [],
  };
  expect(mergeRequirementEntries([result, meituan], [local, tracked], new Map())).toHaveLength(3);
  const entries = mergeRequirementEntries([result, result], [local, tracked], new Map());
  expect(entries.map((entry) => entry.key).sort()).toEqual([issue.url, "local:task"].sort());
  expect(entries.find((entry) => entry.kind === "local")?.group).toBe("todo");
  expect(mergeRequirementEntries([], [local], new Map(), { source: "github" })).toEqual([]);
  expect(
    mergeRequirementEntries([result], [local], new Map(), { source: "local" }).map(
      (entry) => entry.key,
    ),
  ).toEqual(["local:task"]);
  expect(mergeRequirementEntries([], [local], new Map(), { query: "LOGIN" })).toHaveLength(1);
  expect(mergeRequirementEntries([], [local], new Map(), { query: "missing" })).toEqual([]);
  expect(
    mergeRequirementEntries([result], [{ ...local, archived: true }], new Map(), {
      archived: true,
    }).map((entry) => entry.key),
  ).toEqual(["local:task"]);
  expect(
    mergeRequirementEntries([], [{ ...local, status: "in_review" }], new Map())[0]?.group,
  ).toBe("active");
});

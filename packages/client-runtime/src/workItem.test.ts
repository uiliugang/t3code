import {
  CommandId,
  ProjectId,
  WorkItemId,
  type WorkItem,
  type WorkItemCommandInput,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  buildWorkItemContinuePrompt,
  mergeWorkItemPages,
  prepareWorkItemCommandRetry,
} from "./workItem.ts";

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

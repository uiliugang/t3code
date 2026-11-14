import {
  EnvironmentId,
  ProjectId,
  WorkItemId,
  type IssueListResult,
  type WorkItemListResult,
  type WorkItemSummary,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { expect, it } from "vite-plus/test";
import { createRequirementBoardAtoms, RequirementBoardKey } from "./requirementBoard.ts";

it("keeps local pages available when an issue source fails and refreshes overlapping live records", () => {
  const registry = AtomRegistry.make();
  const item: WorkItemSummary = {
    id: WorkItemId.make("local"),
    projectId: ProjectId.make("project"),
    title: "Local task",
    description: "",
    specRevision: 1,
    version: 1,
    status: "todo",
    priority: "P2",
    archived: false,
    createdAt: "2026-11-14T00:00:00Z",
    updatedAt: "2026-11-14T00:00:00Z",
    executionCount: 0,
    activeExecutionCount: 0,
  };
  const cursor = { id: item.id, updatedAt: item.updatedAt };
  const first = Atom.make(
    AsyncResult.success<WorkItemListResult>({ items: [item], candidates: [], nextCursor: cursor }),
  );
  const second = Atom.make<AsyncResult.AsyncResult<WorkItemListResult, unknown>>(
    AsyncResult.success<WorkItemListResult>({
      items: [{ ...item, version: 2, status: "in_progress" }],
      candidates: [],
      nextCursor: null,
    }),
  );
  const empty = Atom.make(
    AsyncResult.success<typeof IssueListResult.Type>({
      groups: [],
      failures: [
        { projectId: item.projectId, reason: "Configure an issue source for this project first." },
      ],
    }),
  );
  const failure = Atom.make(
    AsyncResult.failure<typeof IssueListResult.Type>(Cause.die(new Error("Source unavailable"))),
  );
  const board = createRequirementBoardAtoms({
    issues: ({ input }) => (input.provider === "github" ? empty : failure),
    workItemsLive: ({ input }) => (input.cursor ? second : first),
  });
  const key = new RequirementBoardKey({
    environmentId: EnvironmentId.make("env"),
    projectId: null,
    source: "all",
    assignee: "me",
    query: "",
    page: 2,
    cursors: [undefined, cursor],
    localSupported: true,
    archived: false,
  });
  const unmount = registry.mount(board(key));
  try {
    const data = registry.get(board(key));
    expect(data.errors).toEqual(["Source unavailable"]);
    expect(data.items).toEqual([{ ...item, version: 2, status: "in_progress" }]);
    expect(data.nextCursor).toBeNull();
    expect(data.moreIssues).toBe(false);
    expect(data.issuePages[0]?.failures).toEqual([]);
    expect(
      registry.get(board(new RequirementBoardKey({ ...key, source: "github" }))).issuePages[0]
        ?.failures,
    ).toHaveLength(1);
    expect(
      registry.get(board(new RequirementBoardKey({ ...key, source: "local" }))).errors,
    ).toEqual([]);
    expect(
      registry.get(board(new RequirementBoardKey({ ...key, localSupported: false }))).items,
    ).toEqual([]);
    expect(
      registry.get(board(new RequirementBoardKey({ ...key, archived: true }))).issuePages,
    ).toEqual([]);
    registry.set(
      second,
      AsyncResult.success({
        items: [{ ...item, version: 3, status: "done" }],
        candidates: [],
        nextCursor: null,
      }),
    );
    expect(registry.get(board(key)).items[0]?.version).toBe(3);
    registry.set(
      second,
      AsyncResult.failure<WorkItemListResult>(Cause.die(new Error("Page unavailable"))),
    );
    expect(registry.get(board(key)).nextCursor).toBeNull();
  } finally {
    unmount();
    registry.dispose();
  }
});

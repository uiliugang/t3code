import {
  EnvironmentId,
  ProjectId,
  WorkItemId,
  type RequirementIssueListResult,
  type WorkItemListResult,
  type WorkItemSummary,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { expect, it } from "vite-plus/test";
import {
  createRequirementBoardAtoms,
  RequirementBoardKey,
  createRequirementOverviewAtoms,
  RequirementOverviewKey,
} from "./requirementBoard.ts";

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
  const requests: import("@t3tools/contracts").IssueListInput[] = [];
  const unified = createRequirementBoardAtoms({
    trackers: ({ input }) => {
      requests.push(input);
      return Atom.make(
        AsyncResult.success<import("@t3tools/contracts").IssueListResult>({
          viewers: {},
          entries: [],
          errors: [],
          trackers: [],
          nextCursors: input.cursors ? {} : { "linear.app eng": "opaque" },
        }),
      );
    },
    issues: () => {
      throw new Error("legacy query on unified server");
    },
    workItemsLive: () => {
      throw new Error("local items do not have labels");
    },
  });
  const filtered = registry.get(
    unified(
      new RequirementBoardKey({
        environmentId: EnvironmentId.make("env"),
        source: "all",
        projectId: null,
        assignee: "me",
        query: "",
        labels: ["urgent"],
        page: 2,
        cursors: [undefined],
        localSupported: true,
        archived: false,
        trackerSupported: true,
      }),
    ),
  );
  expect(requests.map(({ labels, cursors }) => ({ labels, cursors }))).toEqual([
    { labels: ["urgent"], cursors: undefined },
    { labels: ["urgent"], cursors: { "linear.app eng": "opaque" } },
  ]);
  expect(filtered.moreIssues).toBe(false);
  const first = Atom.make(
    AsyncResult.success<WorkItemListResult>(
      { items: [item], candidates: [], nextCursor: cursor },
      { waiting: true },
    ),
  );
  const second = Atom.make<AsyncResult.AsyncResult<WorkItemListResult, unknown>>(
    AsyncResult.success<WorkItemListResult>(
      {
        items: [{ ...item, version: 2, status: "in_progress" }],
        candidates: [],
        nextCursor: null,
      },
      { waiting: true },
    ),
  );
  const empty = Atom.make(
    AsyncResult.success<typeof RequirementIssueListResult.Type>({
      groups: [],
      failures: [
        { projectId: item.projectId, reason: "Configure an issue source for this project first." },
      ],
    }),
  );
  const failure = Atom.make(
    AsyncResult.failure<typeof RequirementIssueListResult.Type>(
      Cause.die(new Error("Source unavailable")),
    ),
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
    expect(data.isPending).toBe(false);
    expect(data.errors).toEqual(["Source unavailable"]);
    const disabledMeituan = registry.get(
      board(new RequirementBoardKey({ ...key, meituanEnabled: false })),
    );
    expect(disabledMeituan.errors).toEqual([]);
    expect(disabledMeituan.items).toEqual(data.items);
    expect(disabledMeituan.issuePages).toHaveLength(1);
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
    const repeatedFailure = { projectId: item.projectId, reason: "Source unavailable" };
    const duplicateBoard = createRequirementBoardAtoms({
      issues: () =>
        Atom.make(
          AsyncResult.success<typeof RequirementIssueListResult.Type>({
            groups: [],
            failures: [repeatedFailure],
          }),
        ),
      workItemsLive: () => first,
    });
    expect(registry.get(duplicateBoard(key)).failures).toEqual([repeatedFailure]);
    for (const source of ["github", "meituan"] as const) {
      for (const archived of [false, true]) {
        expect(
          registry.get(board(new RequirementBoardKey({ ...key, source, archived }))).items,
        ).toEqual([{ ...item, version: 2, status: "in_progress" }]);
      }
    }
    registry.set(
      second,
      AsyncResult.success({
        items: [{ ...item, version: 3, status: "done" }],
        candidates: [],
        nextCursor: null,
      }),
    );
    expect(registry.get(board(key)).items[0]?.version).toBe(3);
    registry.set(second, AsyncResult.initial(true));
    expect(registry.get(board(key)).isPending).toBe(true);
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

it("keeps environment identities, failures and pagination separate in the combined board", () => {
  const registry = AtomRegistry.make();
  const firstEnvironment = EnvironmentId.make("first");
  const secondEnvironment = EnvironmentId.make("second");
  const item: WorkItemSummary = {
    id: WorkItemId.make("same-id"),
    projectId: ProjectId.make("same-project"),
    title: "Task",
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
  const requested: Array<{ environmentId: EnvironmentId; cursor: unknown }> = [];
  const settings = Atom.family((_id: EnvironmentId) =>
    Atom.make({ meituanIntegrationEnabled: true, meituanRequirementsEnabled: true }),
  );
  const overview = createRequirementOverviewAtoms({
    issues: ({ environmentId, input }) =>
      Atom.make(
        environmentId === firstEnvironment
          ? AsyncResult.failure<typeof RequirementIssueListResult.Type>(
              Cause.die(new Error(`${input.provider} unavailable`)),
            )
          : AsyncResult.success<typeof RequirementIssueListResult.Type>({
              groups: [],
              failures: [],
            }),
      ),
    workItemsLive: ({ environmentId, input }) => {
      requested.push({ environmentId, cursor: input.cursor });
      return Atom.make(
        AsyncResult.success<WorkItemListResult>({
          items: [{ ...item, title: environmentId }],
          candidates: [],
          nextCursor: environmentId === firstEnvironment && !input.cursor ? cursor : null,
        }),
      );
    },
    config: () => Atom.make({ workItems: true }),
    settings,
    tracked: () => Atom.make(new Map()),
  });
  const key = new RequirementOverviewKey({
    environmentIds: [firstEnvironment, secondEnvironment],
    projectId: null,
    source: "all",
    assignee: "me",
    query: "",
    archived: false,
    pagination: {},
  });
  try {
    const result = registry.get(overview(key));
    expect(result.entries.map((entry) => entry.environmentId).sort()).toEqual([
      firstEnvironment,
      secondEnvironment,
    ]);
    expect(new Set(result.entries.map((entry) => entry.key)).size).toBe(2);
    expect(result.errors.every((error) => error.environmentId === firstEnvironment)).toBe(true);
    expect(result.hasMore).toBe(true);
    registry.set(settings(firstEnvironment), {
      meituanIntegrationEnabled: true,
      meituanRequirementsEnabled: false,
    });
    const paused = registry.get(overview(key));
    expect(paused.errors).toHaveLength(1);
    expect(paused.errors[0]?.message).toBe("github unavailable");
    expect(paused.entries).toEqual(result.entries);
    registry.set(settings(firstEnvironment), {
      meituanIntegrationEnabled: true,
      meituanRequirementsEnabled: true,
    });
    expect(registry.get(overview(key)).errors).toHaveLength(2);
    registry.get(
      overview(new RequirementOverviewKey({ ...key, pagination: result.nextPagination })),
    );
    expect(requested.filter((request) => request.cursor)).toEqual([
      { environmentId: firstEnvironment, cursor },
    ]);
    requested.length = 0;
    const single = registry.get(
      overview(new RequirementOverviewKey({ ...key, environmentIds: [secondEnvironment] })),
    );
    expect(single.entries).toHaveLength(1);
    expect(single.errors).toEqual([]);
    expect(requested.every((request) => request.environmentId === secondEnvironment)).toBe(true);
    expect(
      registry.get(overview(new RequirementOverviewKey({ ...key, environmentIds: [] }))).entries,
    ).toEqual([]);
  } finally {
    registry.dispose();
  }
});

it("preserves tracker issue metadata and applies involvement, state, and sort filters", () => {
  const registry = AtomRegistry.make();
  const environmentId = EnvironmentId.make("env");
  const projectId = ProjectId.make("project");
  const requests: import("@t3tools/contracts").IssueListInput[] = [];
  const overview = createRequirementOverviewAtoms({
    trackers: ({ input }) => {
      requests.push(input);
      return Atom.make(
        AsyncResult.success<import("@t3tools/contracts").IssueListResult>({
          viewers: {},
          entries: [
            {
              tracker: "github" as import("@t3tools/contracts").IssueTrackerKind,
              host: "github.com",
              scope: "acme/app",
              key: "42",
              displayKey: "#42",
              title: "Older issue updated recently",
              url: "https://github.com/acme/app/issues/42",
              author: { login: "alice", name: "Alice", avatarUrl: "https://example.com/a.png" },
              state: { category: "open", boardCategory: "doing", name: "In Progress" },
              createdAt: "2026-11-10T00:00:00Z",
              updatedAt: "2026-11-20T00:00:00Z",
              closedAt: null,
              assignees: [{ login: "bob", name: "Bob", avatarUrl: "https://example.com/b.png" }],
              labels: [{ name: "bug", color: "d73a4a" }],
              commentCount: 5,
              priority: "P1",
              projectId,
              projectTitle: "App",
            },
          ],
          errors: [],
          trackers: [],
          nextCursors: {},
        }),
      );
    },
    issues: () => {
      throw new Error("unexpected legacy issues query");
    },
    workItemsLive: () =>
      Atom.make(
        AsyncResult.success<WorkItemListResult>({
          items: [
            {
              id: WorkItemId.make("local-1"),
              projectId,
              title: "Newer created local item",
              description: "",
              specRevision: 1,
              version: 1,
              status: "done",
              priority: "P2",
              archived: false,
              createdAt: "2026-11-18T00:00:00Z",
              updatedAt: "2026-11-18T00:00:00Z",
              executionCount: 0,
              activeExecutionCount: 0,
            },
          ],
          candidates: [],
          nextCursor: null,
        }),
      ),
    config: () => Atom.make({ workItems: true, requirementIssueTrackers: true }),
    tracked: () => Atom.make(new Map()),
  });

  try {
    const byCreated = registry.get(
      overview(
        new RequirementOverviewKey({
          environmentIds: [environmentId],
          projectId: null,
          source: "all",
          assignee: "all",
          involvement: "all",
          issueState: "all",
          sort: "created",
          query: "",
          archived: false,
          pagination: {},
        }),
      ),
    );
    expect(requests.at(-1)).toMatchObject({ state: "all", sort: "created" });
    expect(byCreated.entries.map((entry) => entry.title)).toEqual([
      "Newer created local item",
      "Older issue updated recently",
    ]);
    const issueEntry = byCreated.entries[1];
    expect(issueEntry?.kind).toBe("issue");
    if (issueEntry?.kind === "issue") {
      expect(issueEntry.issue.displayKey).toBe("#42");
      expect(issueEntry.issue.commentCount).toBe(5);
      expect(issueEntry.issue.labels).toEqual([{ name: "bug", color: "d73a4a" }]);
      expect(issueEntry.issue.assigneeActors?.[0]?.login).toBe("bob");
      expect(issueEntry.issue.author?.login).toBe("alice");
      expect(issueEntry.issue.stateInfo?.name).toBe("In Progress");
    }

    const openOnly = registry.get(
      overview(
        new RequirementOverviewKey({
          environmentIds: [environmentId],
          projectId: null,
          source: "all",
          assignee: "all",
          involvement: "authored",
          issueState: "open",
          sort: "updated",
          query: "",
          archived: false,
          pagination: {},
        }),
      ),
    );
    expect(requests.at(-1)).toMatchObject({ state: "open", involvement: "authored" });
    // Authored involvement and open state both exclude the done local item.
    expect(openOnly.entries.map((entry) => entry.title)).toEqual(["Older issue updated recently"]);
  } finally {
    registry.dispose();
  }
});

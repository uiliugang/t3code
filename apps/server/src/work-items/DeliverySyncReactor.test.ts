import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  WorkItemId,
  WorkItem,
  type IssueDetail,
  type IssueProvider,
  WorkItemError,
  IssueError,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Issues from "../sourceControl/IssueService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as WorkItems from "./WorkItemService.ts";
import * as Mcm from "./McmReleaseService.ts";
import * as DeliverySync from "./DeliverySyncReactor.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
const encodeItemJson = Schema.encodeEffect(Schema.fromJsonString(WorkItem));
const isWorkItemError = Schema.is(WorkItemError);

function setup(provider: IssueProvider, mergedCount?: number, invalidCompletion = false) {
  const sourceId = ThreadId.make("source");
  const prs = ["https://github.com/acme/app/pull/1", "https://github.com/acme/app/pull/2"];
  let published = 0;
  let item: WorkItem = {
    id: WorkItemId.make("delivery-1"),
    projectId: ProjectId.make("project-1"),
    title: "Deliver feature",
    description: "",
    constraints: [],
    acceptanceCriteria: [],
    specRevision: 1,
    version: 1,
    status: "todo",
    priority: "P2",
    archived: false,
    sources: [{ threadId: sourceId, title: "Source" }],
    executions: [],
    submission: null,
    acceptedAt: null,
    createdAt: "2026-11-13T00:00:00.000Z",
    updatedAt: "2026-11-13T00:00:00.000Z",
    delivery: {
      issue: {
        provider,
        repository: provider === "github" ? "acme/app" : "123",
        id: "1",
        url:
          provider === "github"
            ? "https://github.com/acme/app/issues/1"
            : "https://mep.sankuai.com/app/ones/space/123/workItem/requirement/detail/1",
      },
      scope: {
        revision: 1,
        confirmedRevision: 1,
        requiredPullRequests: mergedCount === undefined ? [] : prs,
        changedServices:
          provider === "meituan"
            ? [
                { appkey: "acme.api", target: "prod", revision: prs[0]! },
                { appkey: "acme.worker", target: "prod", revision: prs[1]! },
              ]
            : [],
      },
      evidence: {
        pullRequests: [],
        releases: [],
        planIds: provider === "meituan" ? ["123"] : [],
        anomaly: null,
      },
      completionState: invalidCompletion ? "open" : "completed",
    },
  };
  let closed = 0;
  let failWrite = false;
  let detail: IssueDetail = {
    id: "1",
    url: item.delivery!.issue.url,
    title: item.title,
    state: "open",
    stateCategory: "todo",
    type: "issue",
    assignees: [],
    priority: "",
    updatedAt: "",
    body: "",
    bodyFormat: "markdown",
    transitions: [{ value: "completed", label: "Complete", category: "DONE" }],
  };
  const deps = Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return Layer.mergeAll(
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({
              ...liveThreadShell(sourceId),
              pullRequests: prs.map((url, index) => ({
                host: "github.com",
                repository: "acme/app",
                number: index + 1,
                url,
                source: "agent" as const,
                linkedAt: item.createdAt,
                stack: null,
                snapshot: {
                  state: index < (mergedCount ?? 0) ? ("merged" as const) : ("open" as const),
                  title: "Feature",
                  headBranch: "feature",
                  baseBranch: "main",
                  isDraft: false,
                  updatedAt: null,
                  syncedAt: item.updatedAt,
                },
              })),
            }),
        }),
        Layer.mock(Issues.IssueService)({
          read: () => Effect.succeed(detail),
          setState: () =>
            failWrite
              ? Effect.fail(new IssueError({ operation: "setState", reason: "unavailable" }))
              : Effect.sync(() => {
                  closed++;
                  detail = { ...detail, state: "closed", stateCategory: "done" };
                  return detail;
                }),
        }),
        Layer.mock(Mcm.McmReleaseService)({
          read: () =>
            Effect.succeed(
              (item.delivery?.scope.changedServices ?? [])
                .slice(0, published)
                .map((service) => ({ ...service, planId: "123", completed: true })),
            ),
        }),
        Layer.mock(WorkItems.WorkItemService)({
          get: () => Effect.succeed(item),
          mutate: () => Effect.succeed({ item, replayed: false }),
          recordDelivery: (_id, version, delivery) =>
            Effect.gen(function* () {
              if (version !== item.version)
                return yield* new WorkItemError({ code: "conflict", message: "Changed" });
              item = { ...item, delivery, version: item.version + 1 };
              const json = yield* encodeItemJson(item);
              yield* sql`UPDATE work_items SET item_json = ${json} WHERE id = ${item.id}`;
              return item;
            }).pipe(
              Effect.mapError((cause) =>
                isWorkItemError(cause)
                  ? cause
                  : new WorkItemError({
                      code: "persistence",
                      message: "Fixture persistence failed",
                      cause,
                    }),
              ),
            ),
        }),
      );
    }),
  );
  return {
    layer: DeliverySync.layer.pipe(Layer.provide(deps), Layer.provideMerge(Sqlite.layerMemory)),
    item: () => item,
    closed: () => closed,
    publish: (count: number) => {
      published = count;
    },
    failWrite: () => {
      failWrite = true;
    },
    reopen: () => {
      detail = { ...detail, state: "open", stateCategory: "todo" };
    },
  };
}

it.effect("does not complete an empty scope, including after repeated synchronization", () => {
  const test = setup("github");
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const item = test.item();
    const json = yield* encodeItemJson(item);
    yield* sql`INSERT INTO work_items (id, project_id, updated_at, active_count, item_json) VALUES (${item.id}, ${item.projectId}, ${item.updatedAt}, 0, ${json})`;
    const sync = yield* DeliverySync.DeliverySyncReactor;
    yield* sync.drain();
    yield* sync.drain();
    expect(test.closed()).toBe(0);
    expect(test.item().delivery?.syncedRevision).toBeUndefined();
  }).pipe(Effect.provide(test.layer), Effect.scoped);
});

it.effect(
  "closes GitHub once only when all necessary PRs merged and respects a manual reopen",
  () => {
    const test = setup("github", 2);
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const item = test.item();
      const json = yield* encodeItemJson(item);
      yield* sql`INSERT INTO work_items (id, project_id, updated_at, active_count, item_json) VALUES (${item.id}, ${item.projectId}, ${item.updatedAt}, 0, ${json})`;
      const sync = yield* DeliverySync.DeliverySyncReactor;
      yield* sync.drain();
      yield* sync.drain();
      expect(test.closed()).toBe(1);
      expect(test.item().delivery?.syncedRevision).toBe(1);
      yield* sync.drain();
      const stableVersion = test.item().version;
      yield* sync.drain();
      expect(test.item().version).toBe(stableVersion);
      test.reopen();
      yield* sync.drain();
      expect(test.closed()).toBe(1);
      expect(test.item().delivery?.evidence.anomaly).toContain("reopened");
    }).pipe(Effect.provide(test.layer), Effect.scoped);
  },
);

it.effect("retains a repeated external write failure without duplicate history", () => {
  const test = setup("github", 2);
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const item = test.item();
    const json = yield* encodeItemJson(item);
    yield* sql`INSERT INTO work_items (id, project_id, updated_at, active_count, item_json) VALUES (${item.id}, ${item.projectId}, ${item.updatedAt}, 0, ${json})`;
    const sync = yield* DeliverySync.DeliverySyncReactor;
    test.failWrite();
    yield* sync.drain();
    const version = test.item().version;
    expect(test.item().delivery?.syncError).toContain("Could not synchronize");
    yield* sync.drain();
    expect(test.item().version).toBe(version);
    expect(test.closed()).toBe(0);
  }).pipe(Effect.provide(test.layer), Effect.scoped);
});

it.effect("requires all service releases before completing ONES and flags release reversal", () => {
  const test = setup("meituan", 2);
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const item = test.item();
    const json = yield* encodeItemJson(item);
    yield* sql`INSERT INTO work_items (id, project_id, updated_at, active_count, item_json) VALUES (${item.id}, ${item.projectId}, ${item.updatedAt}, 0, ${json})`;
    const sync = yield* DeliverySync.DeliverySyncReactor;
    test.publish(1);
    yield* sync.drain();
    expect(test.closed()).toBe(0);
    test.publish(2);
    yield* sync.drain();
    expect(test.closed()).toBe(1);
    test.publish(0);
    yield* sync.drain();
    expect(test.closed()).toBe(1);
    expect(test.item().delivery?.evidence.anomaly).toContain("no longer covers");
  }).pipe(Effect.provide(test.layer), Effect.scoped);
});

it.effect(
  "does not write a non-completed workflow state or repeat an unchanged configuration error",
  () => {
    const test = setup("meituan", 2, true);
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const item = test.item();
      const json = yield* encodeItemJson(item);
      yield* sql`INSERT INTO work_items (id, project_id, updated_at, active_count, item_json) VALUES (${item.id}, ${item.projectId}, ${item.updatedAt}, 0, ${json})`;
      const sync = yield* DeliverySync.DeliverySyncReactor;
      test.publish(2);
      yield* sync.drain();
      expect(test.closed()).toBe(0);
      expect(test.item().delivery?.syncError).toContain("completed state");
      const version = test.item().version;
      yield* sync.drain();
      expect(test.item().version).toBe(version);
    }).pipe(Effect.provide(test.layer), Effect.scoped);
  },
);

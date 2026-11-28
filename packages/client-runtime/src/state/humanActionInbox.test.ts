import {
  EnvironmentId,
  NodeId,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2PendingHumanActionSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import {
  collectHumanActions,
  hasLiveHumanAction,
  humanActionSnapshotStatus,
  readHumanActionSnapshot,
  sameHumanAction,
  verifyPendingHumanAction,
} from "./humanActionInbox.ts";

const action = {
  threadId: ThreadId.make("thread"),
  projectId: ProjectId.make("project"),
  requestId: RuntimeRequestId.make("request"),
  targetItemId: TurnItemId.make("card"),
  kind: "user_input" as const,
  createdAt: DateTime.makeUnsafe("2026-11-22T12:00:00.000Z"),
};

describe("human action inbox", () => {
  it("scopes duplicates to their host and places approvals before questions", () => {
    const first = EnvironmentId.make("first");
    const second = EnvironmentId.make("second");
    const approval = { ...action, kind: "approval" as const };
    const gathered = collectHumanActions([
      { environmentId: first, targets: [action, action] },
      { environmentId: second, targets: [action, approval] },
    ]);
    expect(gathered.map(({ environmentId, kind }) => [environmentId, kind])).toEqual([
      [second, "approval"],
      [first, "user_input"],
      [second, "user_input"],
    ]);
  });

  it("does not re-use shell-similar or sibling request/card identities", () => {
    expect(sameHumanAction(action, action)).toBe(true);
    expect(sameHumanAction(action, { ...action, targetItemId: TurnItemId.make("other") })).toBe(
      false,
    );
    expect(sameHumanAction(action, { ...action, threadId: ThreadId.make("child") })).toBe(false);
    expect(sameHumanAction(action, { ...action, projectId: ProjectId.make("other") })).toBe(false);
    expect(
      sameHumanAction(action, { ...action, requestId: RuntimeRequestId.make("another") }),
    ).toBe(false);
    expect(sameHumanAction(action, { ...action, kind: "approval" })).toBe(false);
  });

  it("waits for an authoritative snapshot and refuses a replaced or resolved card", () => {
    const current = AsyncResult.success({ sequence: 4, targets: [action] });
    const streaming = AsyncResult.waiting(current);
    expect(readHumanActionSnapshot(streaming)?.targets).toEqual([action]);
    expect(humanActionSnapshotStatus(streaming, action)).toBe("ready");
    expect(humanActionSnapshotStatus(AsyncResult.success(null), action)).toBe("checking");
    expect(humanActionSnapshotStatus(current, action)).toBe("ready");
    expect(
      humanActionSnapshotStatus(current, { ...action, targetItemId: TurnItemId.make("old") }),
    ).toBe("unavailable");
    expect(
      humanActionSnapshotStatus(AsyncResult.success({ sequence: 5, targets: [] }), action),
    ).toBe("unavailable");
  });

  it("uses the authoritative fresh snapshot and does not wait on a canceled verification", async () => {
    const registry = AtomRegistry.make();
    const fresh = Atom.make<
      AsyncResult.AsyncResult<OrchestrationV2PendingHumanActionSnapshot | null>
    >(AsyncResult.initial());
    const controller = new AbortController();
    const verify = (signal: AbortSignal) =>
      verifyPendingHumanAction(registry, fresh, action, signal);
    const stop = registry.mount(fresh);
    try {
      const found = verify(controller.signal);
      registry.set(fresh, AsyncResult.success({ sequence: 1, targets: [action] }));
      await expect(found).resolves.toBe(true);
      registry.set(fresh, AsyncResult.success(null));
      const replaced = verify(controller.signal);
      registry.set(
        fresh,
        AsyncResult.success({
          sequence: 2,
          targets: [{ ...action, targetItemId: TurnItemId.make("replacement") }],
        }),
      );
      await expect(replaced).resolves.toBe(false);
      registry.set(fresh, AsyncResult.success(null));
      const canceled = verify(controller.signal);
      controller.abort();
      await expect(canceled).resolves.toBe(false);
    } finally {
      stop();
      registry.dispose();
    }
  });

  it("matches the request's node and ignores projections from outside its current project", () => {
    const nodeId = NodeId.make("request-node");
    const thread = {
      id: action.threadId,
      projectId: action.projectId,
      archivedAt: null,
      deletedAt: null,
    };
    const request = {
      id: action.requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: action.createdAt,
      resolvedAt: null,
    } as const;
    const card = {
      id: action.targetItemId,
      threadId: action.threadId,
      nodeId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      providerThreadId: null,
      runId: null,
      ordinal: 0,
      status: "waiting",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: action.createdAt,
      type: "user_input_request",
      requestId: action.requestId,
      questions: [],
    } as const;
    const projection = { thread, runtimeRequests: [request], turnItems: [card] };
    expect(hasLiveHumanAction(projection, action)).toBe(true);
    const pagedProjection = {
      ...projection,
      turnItems: [],
      visibleTurnItems: [
        {
          item: card,
          position: 0,
          visibility: "local",
          sourceThreadId: action.threadId,
          sourceItemId: action.targetItemId,
        },
      ] as const,
    };
    expect(hasLiveHumanAction(pagedProjection, action)).toBe(true);
    expect(
      hasLiveHumanAction(
        { ...pagedProjection, runtimeRequests: [{ ...request, status: "resolved" }] },
        action,
      ),
    ).toBe(false);
    expect(
      hasLiveHumanAction(
        {
          ...projection,
          turnItems: [{ ...card, nodeId: NodeId.make("different-node") }],
        },
        action,
      ),
    ).toBe(false);
    expect(
      hasLiveHumanAction(
        {
          ...projection,
          thread: { ...thread, archivedAt: action.createdAt },
        },
        action,
      ),
    ).toBe(false);
    expect(
      hasLiveHumanAction(
        {
          ...projection,
          thread: { ...thread, projectId: ProjectId.make("different-project") },
        },
        action,
      ),
    ).toBe(false);
  });
});

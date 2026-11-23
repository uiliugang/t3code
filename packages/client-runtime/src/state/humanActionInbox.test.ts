import {
  EnvironmentId,
  NodeId,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import {
  collectHumanActions,
  hasLiveHumanAction,
  humanActionSnapshotStatus,
  readHumanActionSnapshot,
  sameHumanAction,
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

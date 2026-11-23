import {
  EnvironmentId,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { collectHumanActions, sameHumanAction } from "./humanActionInbox.ts";

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
    expect(
      sameHumanAction(action, { ...action, requestId: RuntimeRequestId.make("another") }),
    ).toBe(false);
    expect(sameHumanAction(action, { ...action, kind: "approval" })).toBe(false);
  });
});

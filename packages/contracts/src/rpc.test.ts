import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { AuthOrchestrationOperateScope, AuthSourceControlWriteScope } from "./auth.ts";

describe("WebSocket RPC contracts", () => {
  it("requires both permissions for delivery writes without blocking local task updates", () => {
    const both = [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
    expect(clientRpcRequiredScopes(WS_METHODS.workItemsCreateIssue, undefined)).toEqual(both);
    expect(clientRpcRequiredScopes(WS_METHODS.workItemsRefreshDelivery, undefined)).toEqual(both);
    for (const type of ["confirm_scope", "completion_state", "reopen_delivery"])
      expect(clientRpcRequiredScopes(WS_METHODS.workItemsMutate, { type })).toEqual(both);
    expect(clientRpcRequiredScopes(WS_METHODS.workItemsMutate, { type: "move" })).toEqual([
      AuthOrchestrationOperateScope,
    ]);
  });
  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });

  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });
});

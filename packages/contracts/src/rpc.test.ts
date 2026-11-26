import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  ATTACHMENT_TRANSFER_CHUNK_BYTES,
  AssetCreateUrlResult,
  AttachmentCreateUploadUrlResult,
  AttachmentReadChunkInput,
  AttachmentReadChunkResult,
  AttachmentWriteChunkInput,
  WorkspaceFileReadChunkInput,
} from "./assets.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
} from "./auth.ts";
import { RequirementIssueError } from "./issues.ts";

const decodeIssueError = Schema.decodeUnknownSync(RequirementIssueError);
const encodeIssueError = Schema.encodeSync(RequirementIssueError);
const decodeReadChunk = Schema.decodeSync(AttachmentReadChunkResult);
const decodeReadRange = Schema.decodeSync(AttachmentReadChunkInput);
const decodeWorkspaceRange = Schema.decodeUnknownExit(WorkspaceFileReadChunkInput);

describe("WebSocket RPC contracts", () => {
  it("preserves the private DaXiang login tab while accepting legacy void responses", () => {
    const schema = WsRpcGroup.requests.get(WS_METHODS.daxiangApprovalMutate)!.successSchema;
    const tab = { threadId: "private-browser:login", tabId: "tab" };
    expect(Schema.decodeUnknownSync(schema)(Schema.encodeSync(schema)(tab))).toEqual(tab);
    expect(Schema.encodeSync(schema)(undefined)).toBeUndefined();
  });

  it("requires preview permissions only to open the built-in DaXiang browser", () => {
    const method = WS_METHODS.daxiangApprovalMutate;
    expect(clientRpcRequiredScopes(method, { type: "open_browser_login" })).toEqual([
      AuthSettingsWriteScope,
      AuthOrchestrationReadScope,
      AuthPreviewOperateScope,
    ]);
    expect(clientRpcRequiredScopes(method, { type: "login" })).toEqual([AuthSettingsWriteScope]);
  });

  it("keeps shipped requirement clients and servers on the same wire contract", () => {
    const target = { provider: "github", projectId: "project" };
    for (const [wire, current, payload] of [
      [
        "issues.list",
        WS_METHODS.requirementIssuesList,
        { ...target, assignee: "me", query: "", page: 1 },
      ],
      [
        "issues.create",
        WS_METHODS.requirementIssuesCreate,
        {
          ...target,
          type: "REQUIREMENT",
          subtype: "",
          title: "Fix",
          body: "",
          fields: {},
          assignees: [],
        },
      ],
      [
        "issues.setState",
        WS_METHODS.requirementIssuesSetState,
        { ...target, id: "42", state: "done" },
      ],
    ] as const) {
      expect(current).toBe(wire);
      const decodePayload = Schema.decodeUnknownSync(WsRpcGroup.requests.get(wire)!.payloadSchema);
      expect(decodePayload(payload)).toEqual(payload);
    }
    const failure = { _tag: "IssueError", operation: "create", reason: "validation" };
    expect(encodeIssueError(decodeIssueError(failure))).toEqual(failure);
  });
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
  it("bounds attachment bytes on the JSON wire and permits a zero-length metadata read", () => {
    const payload = { attachmentId: "pending-1", offset: 0 };
    const decode = Schema.decodeUnknownExit(AttachmentWriteChunkInput);
    const encode = Schema.encodeSync(AttachmentWriteChunkInput);
    const data = Uint8Array.of(0, 128, 255);
    expect(encode({ ...payload, data })).toEqual({ ...payload, data: "AID/" });
    expect(decodeReadChunk({ totalBytes: 3, data: "AID/" }).data).toEqual(data);
    const largest = "AAAA".repeat(ATTACHMENT_TRANSFER_CHUNK_BYTES / 3);
    expect(Exit.isSuccess(decode({ ...payload, data: largest }))).toBe(true);
    for (const invalid of ["", "*!?!", largest + "AA=="])
      expect(Exit.isFailure(decode({ ...payload, data: invalid }))).toBe(true);
    const metadata = { ...payload, length: 0 };
    expect(decodeReadRange(metadata)).toEqual(metadata);
    expect(clientRpcRequiredScopes(WS_METHODS.attachmentsReadChunk, metadata)).toEqual([
      AuthOrchestrationReadScope,
    ]);
    const range = { offset: 10, length: 0, revision: "v1" };
    const draft = { _tag: "draft-workspace-file", cwd: "/repo", path: "notes.txt" };
    expect(Exit.isSuccess(decodeWorkspaceRange({ ...range, resource: draft }))).toBe(true);
    expect(
      Exit.isFailure(
        decodeWorkspaceRange({
          ...range,
          resource: { _tag: "attachment", attachmentId: "pending-1" },
        }),
      ),
    ).toBe(true);
    expect(
      clientRpcRequiredScopes(WS_METHODS.assetsReadWorkspaceChunk, { ...range, resource: draft }),
    ).toEqual([AuthFilesystemReadScope]);
    for (const method of [WS_METHODS.attachmentsBeginUpload, WS_METHODS.attachmentsWriteChunk])
      expect(clientRpcRequiredScopes(method, undefined)).toEqual([AuthOrchestrationOperateScope]);
  });
  it("only accepts asset and upload URLs on their own server routes", () => {
    const decodeAsset = Schema.decodeUnknownExit(AssetCreateUrlResult);
    const decodeUpload = Schema.decodeUnknownExit(AttachmentCreateUploadUrlResult);
    const expiresAt = 10_000;

    expect(
      Exit.isSuccess(
        decodeAsset({ relativeUrl: "/api/assets/token.sig/my%20file.png", expiresAt }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decodeUpload({
          relativeUrl: "/api/attachments/upload/token.sig",
          expiresAt,
          attachmentId: "attachment",
        }),
      ),
    ).toBe(true);

    for (const relativeUrl of [
      "data:text/plain,hello",
      "file:///tmp/document",
      "https://other.example/document",
      "//other.example/document",
      "/api/assets/token/../../../other",
    ]) {
      expect(Exit.isFailure(decodeAsset({ relativeUrl, expiresAt }))).toBe(true);
      expect(
        Exit.isFailure(decodeUpload({ relativeUrl, expiresAt, attachmentId: "attachment" })),
      ).toBe(true);
    }
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

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  applyAutomaticDraftWorktreeBase,
  readPendingDraftCheckout,
  readPendingWorkspaceDefault,
  readPreparedDraftCheckout,
  trackPendingDraftCheckout,
} from "./draftWorkspaceDefaults";

const environmentId = EnvironmentId.make("environment-1");
const project = (id: string) => scopeProjectRef(environmentId, ProjectId.make(id));
const source = project("source");
const destination = project("destination");
const draftId = DraftId.make("test-checkout");
const get = () => useComposerDraftStore.getState();

beforeEach(() => {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  get().setProjectDraftThreadId(source, draftId, { branch: "original" });
});

const prepare = (isCancelled = () => false) => {
  const raw = Promise.withResolvers<"success" | "failure">();
  const apply = vi.fn((value: "success" | "failure") => {
    if (value === "failure") return false;
    get().setDraftThreadContext(draftId, { branch: "pr-1", worktreePath: "/worktrees/pr-1" });
    return true;
  });
  const result = trackPendingDraftCheckout(draftId, source, raw.promise, apply, isCancelled);
  return { raw, apply, result };
};

it("keeps typed text and makes the prepared workspace available even to a detached sender", async () => {
  const checkout = prepare();
  const detached = readPendingDraftCheckout(draftId)!;
  const current = readPendingWorkspaceDefault(draftId);
  get().setPrompt(draftId, "Review this");
  checkout.raw.resolve("success");
  expect(await checkout.result).toMatchObject({ applied: true });
  expect(await current).toBe(true);
  const outcome = await detached;
  expect(outcome.status).toBe("ready");
  if (outcome.status !== "ready") throw new Error("checkout not ready");
  expect(readPreparedDraftCheckout(draftId, outcome.workspace)).toMatchObject({
    branch: "pr-1",
    worktreePath: "/worktrees/pr-1",
  });
  expect(get().getComposerDraft(draftId)?.prompt).toBe("Review this");
  get().setDraftThreadContext(draftId, { branch: "later", worktreePath: null });
  expect(readPreparedDraftCheckout(draftId, outcome.workspace)).toBeNull();
});

it.each(["automatic", "manual"] as const)(
  "handles %s base branch selection while checkout is pending",
  async (selection) => {
    get().setDraftThreadContext(draftId, {
      branch: null,
      envMode: "worktree",
      workspaceExplicit: true,
      environmentSelection: "manual",
    });
    const checkout = prepare();
    const selectBase = () => get().setDraftThreadContext(draftId, { branch: "main" });
    if (selection === "automatic") applyAutomaticDraftWorktreeBase(draftId, selectBase);
    else selectBase();

    checkout.raw.resolve("success");
    const automatic = selection === "automatic";
    expect(await checkout.result).toMatchObject({ applied: automatic });
    expect(get().getDraftSession(draftId)).toMatchObject({
      branch: automatic ? "pr-1" : "main",
      worktreePath: automatic ? "/worktrees/pr-1" : null,
    });
  },
);

it("an older checkout cannot overwrite the new project or its text", async () => {
  const checkout = prepare();
  const send = readPendingWorkspaceDefault(draftId);
  get().setDraftThreadContext(draftId, {
    projectRef: destination,
    branch: "destination-branch",
    worktreePath: "/worktrees/destination",
  });
  get().setPrompt(draftId, "Do not submit this elsewhere");
  expect(await send).toBe("moved");
  expect(readPendingDraftCheckout(draftId)).toBeNull();
  checkout.raw.resolve("success");
  expect(await checkout.result).toMatchObject({ applied: false });
  expect(checkout.apply).not.toHaveBeenCalled();
  expect(get().getDraftSession(draftId)).toMatchObject({
    projectId: destination.projectId,
    branch: "destination-branch",
    worktreePath: "/worktrees/destination",
  });
  expect(get().getComposerDraft(draftId)?.prompt).toBe("Do not submit this elsewhere");
});

it.each(["failure", "cancel"] as const)(
  "%s blocks a waiting send without consuming text",
  async (failure) => {
    const checkout = prepare(() => failure === "cancel");
    const send = readPendingWorkspaceDefault(draftId);
    const dictation = readPendingDraftCheckout(draftId)!;
    get().setPrompt(draftId, "Keep my work");
    checkout.raw.resolve(failure === "cancel" ? "success" : "failure");
    expect(await checkout.result).toMatchObject({ applied: false });
    expect(await send).toBe(false);
    expect((await dictation).status).not.toBe("ready");
    expect(get().getDraftSession(draftId)?.branch).toBe("original");
    expect(get().getComposerDraft(draftId)?.prompt).toBe("Keep my work");
  },
);

it("does not revive a checkout after moving away and back or superseding it", async () => {
  const older = prepare();
  const olderResult = readPendingDraftCheckout(draftId)!;
  get().setDraftThreadContext(draftId, { projectRef: destination });
  get().setDraftThreadContext(draftId, { projectRef: source, branch: "original" });
  const newer = prepare();
  older.raw.resolve("success");
  expect((await olderResult).status).toBe("moved");
  expect(older.apply).not.toHaveBeenCalled();
  newer.raw.resolve("success");
  expect(await newer.result).toMatchObject({ applied: true });
});

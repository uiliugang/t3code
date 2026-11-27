import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { composerTargetKey, DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  trackPendingDraftCheckout,
  trackPendingWorkspaceDefault,
} from "../../lib/draftWorkspaceDefaults";
import {
  addPreparingComposerImages,
  cancelHeldComposerSend,
  cancelPreparingComposerImages,
  holdComposerSend,
  joinPreparedImagesToDraft,
  removePreparingComposerImages,
  watchComposerSendEdits,
} from "./preparingComposerImages";

function preparingImage(id: string) {
  return { id, name: `${id}.png`, file: new File(["png"], `${id}.png`), hidden: false };
}

it("holds a message send until its images join the draft, and cancels on edit, cancel, or new paste", async () => {
  const draftTarget = scopeThreadRef(EnvironmentId.make("environment-held"), ThreadId.make("held"));
  const target = composerTargetKey(draftTarget);
  const drafts = useComposerDraftStore.getState();
  using _store = {
    [Symbol.dispose]: () => {
      cancelPreparingComposerImages(target);
      drafts.clearComposerContent(draftTarget);
    },
  };
  drafts.setPrompt(draftTarget, "check");
  expect(holdComposerSend(draftTarget)).toBeNull();

  // Two pastes compress separately; the first joining the draft is not an edit.
  addPreparingComposerImages(target, [preparingImage("first")]);
  addPreparingComposerImages(target, [preparingImage("second")]);
  const held = holdComposerSend(draftTarget);
  await expect(holdComposerSend(draftTarget)).resolves.toEqual({ status: "cancelled" });
  removePreparingComposerImages(target, new Set(["first"]));
  joinPreparedImagesToDraft(() => drafts.setPrompt(draftTarget, "check first"));
  removePreparingComposerImages(target, new Set(["second"]));
  await expect(held).resolves.toEqual({ status: "ready" });

  for (const cancel of [
    () => drafts.setPrompt(draftTarget, "check again"),
    () =>
      drafts.setProviderModelOptions(draftTarget, ProviderDriverKind.make("codex"), [
        { id: "reasoningEffort", value: "high" },
      ]),
    () => cancelHeldComposerSend(target),
    () => addPreparingComposerImages(target, [preparingImage("added-mid-wait")]),
    () => removePreparingComposerImages(target, new Set(["later"]), { cancelSubmission: true }),
  ]) {
    addPreparingComposerImages(target, [preparingImage("later")]);
    const cancelled = holdComposerSend(draftTarget);
    cancel();
    await expect(cancelled).resolves.toEqual({ status: "cancelled" });
    cancelPreparingComposerImages(target);
  }
});

it("cancels an image-held send when its draft's worktree base changes", async () => {
  const id = DraftId.make("held-image-worktree");
  const environmentId = EnvironmentId.make("environment-held");
  const targetKey = composerTargetKey(id);
  const drafts = useComposerDraftStore.getState();
  drafts.setProjectDraftThreadId(
    scopeProjectRef(environmentId, ProjectId.make("project-held")),
    id,
    {
      envMode: "worktree",
      branch: "main",
    },
  );
  using _store = {
    [Symbol.dispose]: () => {
      cancelPreparingComposerImages(targetKey);
      drafts.clearDraftThread(id);
    },
  };
  addPreparingComposerImages(targetKey, [preparingImage("held-worktree")]);
  const held = holdComposerSend(id);
  drafts.setDraftThreadContext(id, { branch: "release" });
  removePreparingComposerImages(targetKey, new Set(["held-worktree"]));
  await expect(held).resolves.toEqual({ status: "cancelled" });
});

it("keeps an image-held send alive when a pending workspace default or PR checkout settles", async () => {
  const environmentId = EnvironmentId.make("environment-held");
  const defaultProjectRef = scopeProjectRef(environmentId, ProjectId.make("project-held-defaults"));
  const checkoutProjectRef = scopeProjectRef(
    environmentId,
    ProjectId.make("project-held-checkout"),
  );
  const drafts = useComposerDraftStore.getState();

  const defaultId = DraftId.make("held-image-default");
  const defaultTargetKey = composerTargetKey(defaultId);
  drafts.setProjectDraftThreadId(defaultProjectRef, defaultId, {
    envMode: "local",
    startFromOrigin: false,
  });

  const checkoutId = DraftId.make("held-image-checkout");
  const checkoutTargetKey = composerTargetKey(checkoutId);
  drafts.setProjectDraftThreadId(checkoutProjectRef, checkoutId, {
    envMode: "local",
  });

  using _store = {
    [Symbol.dispose]: () => {
      cancelPreparingComposerImages(defaultTargetKey);
      cancelPreparingComposerImages(checkoutTargetKey);
      drafts.clearDraftThread(defaultId);
      drafts.clearDraftThread(checkoutId);
    },
  };

  let resolveDefault!: (value: { envMode: "worktree"; startFromOrigin: true }) => void;
  trackPendingWorkspaceDefault(
    defaultId,
    defaultProjectRef,
    { envMode: "local", startFromOrigin: false },
    new Promise((resolve) => {
      resolveDefault = resolve;
    }),
  );
  addPreparingComposerImages(defaultTargetKey, [preparingImage("held-default")]);
  const heldDefault = holdComposerSend(defaultId);
  resolveDefault({ envMode: "worktree", startFromOrigin: true });
  await Promise.resolve();
  await Promise.resolve();
  expect(drafts.getDraftSession(defaultId)?.envMode).toBe("worktree");
  removePreparingComposerImages(defaultTargetKey, new Set(["held-default"]));
  await expect(heldDefault).resolves.toEqual({ status: "ready" });

  let resolveCheckout!: (value: { branch: string; worktreePath: string }) => void;
  const pendingCheckout = trackPendingDraftCheckout(
    checkoutId,
    checkoutProjectRef,
    new Promise<{ branch: string; worktreePath: string }>((resolve) => {
      resolveCheckout = resolve;
    }),
    ({ branch, worktreePath }) => {
      drafts.setDraftThreadContext(checkoutId, {
        branch,
        worktreePath,
        envMode: "worktree",
        workspaceExplicit: true,
        environmentSelection: "manual",
      });
      return true;
    },
    () => false,
  );
  addPreparingComposerImages(checkoutTargetKey, [preparingImage("held-checkout")]);
  const heldCheckout = holdComposerSend(checkoutId);
  resolveCheckout({ branch: "pr-branch", worktreePath: "/tmp/pr-worktree" });
  await pendingCheckout;
  expect(drafts.getDraftSession(checkoutId)?.worktreePath).toBe("/tmp/pr-worktree");
  removePreparingComposerImages(checkoutTargetKey, new Set(["held-checkout"]));
  await expect(heldCheckout).resolves.toEqual({ status: "ready" });
});

it("distinguishes draft edits from attachment progress while routing a send", () => {
  const environmentId = EnvironmentId.make("environment-routing");
  const draftTarget = scopeThreadRef(environmentId, ThreadId.make("routing"));
  const target = composerTargetKey(draftTarget);
  const drafts = useComposerDraftStore.getState();
  using _store = {
    [Symbol.dispose]: () => {
      cancelPreparingComposerImages(target);
      drafts.clearComposerContent(draftTarget);
    },
  };
  const file = new File(["text"], "notes.txt", { type: "text/plain" });
  drafts.setPrompt(draftTarget, "read these");
  const setEffort = (value: string) =>
    drafts.setProviderModelOptions(draftTarget, ProviderDriverKind.make("codex"), [
      { id: "reasoningEffort", value },
    ]);
  setEffort("medium");
  const finishSameEffortSend = watchComposerSendEdits(draftTarget);
  setEffort("medium");
  expect(finishSameEffortSend()).toBe("ready");

  drafts.addFiles(draftTarget, [
    { type: "file", id: "notes", name: file.name, mimeType: file.type, sizeBytes: file.size, file },
  ]);
  const image = preparingImage("submitted");
  addPreparingComposerImages(target, [image]);
  const finishUnchangedSend = watchComposerSendEdits(draftTarget);
  drafts.setPrompt(draftTarget, drafts.getComposerDraft(draftTarget)!.prompt);
  drafts.setFileUpload(draftTarget, "notes", environmentId, "uploaded-notes");
  joinPreparedImagesToDraft(() =>
    drafts.addImages(draftTarget, [
      {
        type: "image",
        id: image.id,
        name: image.name,
        mimeType: "image/png",
        sizeBytes: image.file.size,
        previewUrl: URL.createObjectURL(image.file),
        file: image.file,
      },
    ]),
  );
  removePreparingComposerImages(target, new Set([image.id]));
  expect(finishUnchangedSend()).toBe("ready");

  for (const edit of [
    () => drafts.setPrompt(draftTarget, "replacement"),
    () => setEffort("high"),
    () => addPreparingComposerImages(target, [preparingImage("unsubmitted")]),
  ]) {
    const finishEditedSend = watchComposerSendEdits(draftTarget);
    edit();
    expect(finishEditedSend()).toBe("edited");
  }

  const finishCancelledSend = watchComposerSendEdits(draftTarget);
  drafts.setPrompt(draftTarget, "another edit");
  removePreparingComposerImages(target, new Set(["unsubmitted"]), { cancelSubmission: true });
  expect(finishCancelledSend()).toBe("attachments-cancelled");
});

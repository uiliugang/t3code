import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { composerTargetKey, DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  addPreparingComposerImages,
  cancelHeldComposerSend,
  cancelPreparingComposerImages,
  holdComposerSend,
  joinPreparedImagesToDraft,
  removePreparingComposerImages,
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

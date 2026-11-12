import { ChatAttachmentId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore } from "../../composerDraftStore";
import { randomUUID } from "../../lib/utils";
import type { ChatMessage } from "../../types";
import { rewindToMessage } from "./chatViewSend";

vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  readPreparedConnection: () => ({ httpBaseUrl: "http://localhost" }),
}));

vi.mock("../ChatView.logic", () => ({
  prepareRevertedMessageAttachments: async ({ message }: { message: ChatMessage }) =>
    (message.attachments ?? []).map(
      (attachment) => new File(["attachment"], attachment.name, { type: attachment.mimeType }),
    ),
  waitForRevertedMessage: async (
    _ref: unknown,
    _count: unknown,
    _commandId: unknown,
    revert: () => Promise<void>,
  ) => revert(),
}));

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function setup(withAttachment = false) {
  const environmentId = EnvironmentId.make("rewind-environment");
  const threadId = ThreadId.make(randomUUID());
  const target = scopeThreadRef(environmentId, threadId);
  const message: ChatMessage = {
    id: MessageId.make("original-message"),
    role: "user",
    text: "Original prompt",
    runId: null,
    streaming: false,
    createdAt: "2026-11-12T00:00:00.000Z",
    updatedAt: "2026-11-12T00:00:00.000Z",
    attachments: withAttachment
      ? [
          {
            id: ChatAttachmentId.make("file"),
            type: "file",
            name: "report.txt",
            mimeType: "text/plain",
            sizeBytes: 10,
          },
        ]
      : [],
  };
  const store = useComposerDraftStore.getState();
  return {
    store,
    target,
    input: {
      message,
      environmentId,
      threadId,
      routeThreadRef: target,
      turnCount: 0,
      restoreFiles: false,
      checkpoint: undefined,
      draftTarget: target,
      composerHasPendingAttachments: false,
      createAssetUrl: vi.fn(),
    },
  };
}

it("restores the prompt before rollback finishes and preserves edits made while waiting", async () => {
  const { store, target, input } = setup();
  store.setPrompt(target, "Existing draft");
  const rollback = deferred();
  const started = deferred();
  const waiting = rewindToMessage({
    ...input,
    revertThreadCheckpoint: async () => {
      started.resolve();
      await rollback.promise;
      return AsyncResult.success(undefined);
    },
  });
  expect(store.getComposerDraft(target)?.prompt).toBe("Existing draft\n\nOriginal prompt");
  await started.promise;
  store.setPrompt(target, "Edited while rewinding");
  rollback.resolve();
  expect(await waiting).toMatchObject({ error: null });
  expect(store.getComposerDraft(target)?.prompt).toBe("Edited while rewinding");
});

it.each([false, true])(
  "retains edits and avoids duplicate recall on retry (attachment: %s)",
  async (withAttachment) => {
    const { store, target, input } = setup(withAttachment);
    expect(
      await rewindToMessage({
        ...input,
        revertThreadCheckpoint: async () => {
          throw new Error("Rollback failed");
        },
      }),
    ).toMatchObject({ error: "Rollback failed" });
    expect(store.getComposerDraft(target)?.prompt).toBe("Original prompt");
    const files = store.getComposerDraft(target)?.files;
    expect(files).toHaveLength(withAttachment ? 1 : 0);
    store.setPrompt(target, "Keep these edits");
    expect(
      await rewindToMessage({
        ...input,
        revertThreadCheckpoint: async () => AsyncResult.success(undefined),
      }),
    ).toMatchObject({ error: null });
    expect(store.getComposerDraft(target)?.prompt).toBe("Keep these edits");
    expect(store.getComposerDraft(target)?.files).toEqual(files);
  },
);

it("leaves the draft alone when attachments are still preparing", async () => {
  const { store, target, input } = setup();
  store.setPrompt(target, "Pending draft");
  const result = await rewindToMessage({
    ...input,
    composerHasPendingAttachments: true,
    revertThreadCheckpoint: async () => AsyncResult.success(undefined),
  });
  expect(result.error).toContain("Wait for attachments");
  expect(store.getComposerDraft(target)?.prompt).toBe("Pending draft");
});

it("recalls the message again when the failed rewind's draft was cleared", async () => {
  const { store, target, input } = setup();
  await rewindToMessage({
    ...input,
    revertThreadCheckpoint: async () => {
      throw new Error("Rollback failed");
    },
  });
  store.clearComposerContent(target);
  expect(
    await rewindToMessage({
      ...input,
      revertThreadCheckpoint: async () => AsyncResult.success(undefined),
    }),
  ).toMatchObject({ error: null });
  expect(store.getComposerDraft(target)?.prompt).toBe("Original prompt");
});

import { EnvironmentId, ProjectId, ProjectNoteId, type ProjectNote } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { beginNoteSave, confirmNoteSave, makeNoteDraft, openSavedNote } from "./projectNoteDraft";
import { noteMutationUnconfirmed } from "./projectNoteMutation";
import { confirmProjectNoteDrafts } from "./projectNoteDraftVault";

const environmentId = EnvironmentId.make("native");
const other = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
const saved: ProjectNote = {
  id: ProjectNoteId.make("note"),
  projectId,
  title: "Local",
  markdown: "Saved",
  revision: 4,
  archivedAt: null,
  createdAt: "2026-11-22T00:00:00Z",
  updatedAt: "2026-11-22T00:00:00Z",
};
const dirty = {
  ...makeNoteDraft({ ...saved, clientScopeKey: environmentId }),
  markdown: "Unsent private",
};

it("hides a dirty draft until the same desktop bridge, host, project and saved note are verified", async () => {
  let host: EnvironmentId | null = environmentId;
  const bridge = { getProjectNotesEnvironment: async () => host };
  const first = (await confirmProjectNoteDrafts(bridge, environmentId, projectId))!;
  first.retain(dirty);
  host = null;
  expect(await confirmProjectNoteDrafts(bridge, environmentId, projectId)).toBeNull();
  host = other;
  expect(
    await (
      await confirmProjectNoteDrafts(bridge, other, projectId)
    )?.restorePending(async () => saved),
  ).toEqual({ available: true, draft: null });
  host = environmentId;
  expect(
    await (
      await confirmProjectNoteDrafts(
        { getProjectNotesEnvironment: async () => environmentId },
        environmentId,
        projectId,
      )
    )?.restorePending(async () => saved),
  ).toEqual({ available: true, draft: null });
  expect(
    await (
      await confirmProjectNoteDrafts(bridge, environmentId, ProjectId.make("other"))
    )?.restorePending(async () => saved),
  ).toEqual({ available: true, draft: null });
  const reopened = (await confirmProjectNoteDrafts(bridge, environmentId, projectId))!;
  expect(
    await reopened.restorePending(async () => ({ ...saved, id: ProjectNoteId.make("other") })),
  ).toEqual({ available: false });
  expect(await reopened.restorePending(async () => ({ ...saved, revision: 3 }))).toEqual({
    available: false,
  });
  expect(await reopened.restorePending(async () => null)).toEqual({ available: false });
  first.retain(null);
  expect(await reopened.restorePending(async () => saved)).toEqual({
    available: true,
    draft: dirty,
  });
  const conflicting = await reopened.restorePending(async () => ({ ...saved, revision: 5 }));
  if (!conflicting.available || !conflicting.draft)
    throw new Error("Expected an owner-bound conflict");
  expect(conflicting.draft.conflictingRevision).toBe(5);
  expect(beginNoteSave(conflicting.draft, () => "no stale retry")).toBeNull();
});

it("applies only the acknowledged revision and does not drop typing after submit", () => {
  const snapshot = beginNoteSave(dirty, () => "save")!;
  const later = { ...dirty, markdown: "New text" };
  const wrongScope = { ...later, clientScopeKey: other };
  expect(confirmNoteSave(wrongScope, snapshot, { id: saved.id, revision: 5 })).toBe(wrongScope);
  const confirmed = confirmNoteSave(later, snapshot, { id: saved.id, revision: 5 });
  expect(confirmed.markdown).toBe("New text");
  expect(confirmed.base.markdown).toBe(dirty.markdown);
});

it("preserves edits typed while another note is loading", () => {
  const destination = { ...saved, id: ProjectNoteId.make("next"), clientScopeKey: environmentId };
  expect(
    openSavedNote(makeNoteDraft({ ...saved, clientScopeKey: environmentId }), destination).id,
  ).toBe(destination.id);
  expect(openSavedNote(dirty, destination)).toBe(dirty);
});

it("retries the submitted save unchanged after a lost reply, then keeps newer typing", () => {
  const first = beginNoteSave(dirty, () => "original");
  if (!first) throw new Error("Expected an initial save");
  const outcome = { ok: false, failure: { reason: "unavailable" } } as const;
  expect(noteMutationUnconfirmed(outcome, "update")).toBe(true);
  expect(noteMutationUnconfirmed(outcome, "create")).toBe(true);
  expect(noteMutationUnconfirmed({ ok: false, failure: { reason: "conflict" } }, "update")).toBe(
    false,
  );
  const editedBackToBase = { ...dirty, markdown: saved.markdown };
  expect(beginNoteSave(editedBackToBase, () => "must not change", first)).toBe(first);
  const confirmed = confirmNoteSave(editedBackToBase, first, { id: saved.id, revision: 5 });
  expect(confirmed.markdown).toBe(saved.markdown);
  expect(beginNoteSave(confirmed, () => "next", first)).toMatchObject({
    mutationId: "next",
    expectedRevision: 5,
    markdown: saved.markdown,
  });
});

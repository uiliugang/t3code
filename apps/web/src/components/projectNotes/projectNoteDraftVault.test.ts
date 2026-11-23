import { EnvironmentId, ProjectId, ProjectNoteId, type ProjectNote } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { beginNoteSave, confirmNoteSave, makeNoteDraft } from "./projectNoteDraft";
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
  expect((await confirmProjectNoteDrafts(bridge, other, projectId))?.getPendingNoteId()).toBeNull();
  host = environmentId;
  expect(
    (
      await confirmProjectNoteDrafts(
        { getProjectNotesEnvironment: async () => environmentId },
        environmentId,
        projectId,
      )
    )?.getPendingNoteId(),
  ).toBeNull();
  expect(
    (
      await confirmProjectNoteDrafts(bridge, environmentId, ProjectId.make("other"))
    )?.getPendingNoteId(),
  ).toBeNull();
  const reopened = (await confirmProjectNoteDrafts(bridge, environmentId, projectId))!;
  expect(reopened.restore({ ...saved, id: ProjectNoteId.make("other") })).toBeNull();
  expect(reopened.restore({ ...saved, revision: 3 })).toBeNull();
  expect(reopened.restore(saved)?.markdown).toBe(dirty.markdown);
  first.retain(null);
  expect(reopened.restore(saved)?.markdown).toBe(dirty.markdown);
  const conflict = reopened.restore({ ...saved, revision: 5 });
  if (!conflict) throw new Error("Expected an owner-bound conflict");
  expect(conflict.conflictingRevision).toBe(5);
  expect(beginNoteSave(conflict, "no stale retry")).toBeNull();
});

it("applies only the acknowledged revision and does not drop typing after submit", () => {
  const snapshot = beginNoteSave(dirty, "save")!;
  const later = { ...dirty, markdown: "New text" };
  const wrongScope = { ...later, clientScopeKey: other };
  expect(confirmNoteSave(wrongScope, snapshot, { id: saved.id, revision: 5 })).toBe(wrongScope);
  const confirmed = confirmNoteSave(later, snapshot, { id: saved.id, revision: 5 });
  expect(confirmed.markdown).toBe("New text");
  expect(confirmed.base.markdown).toBe(dirty.markdown);
});

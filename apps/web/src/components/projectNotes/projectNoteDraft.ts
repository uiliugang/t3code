import type { ProjectNoteMutationResult, ProjectNoteRef } from "@t3tools/contracts";

type LocalNoteRef = ProjectNoteRef & { readonly clientScopeKey: string };
type NoteValues = { readonly title: string; readonly markdown: string };
export type NoteDraft = LocalNoteRef &
  NoteValues & {
    readonly base: NoteValues & { readonly revision: number };
    readonly conflictingRevision: number | null;
  };
export type NoteSaveSnapshot = LocalNoteRef &
  NoteValues & { readonly expectedRevision: number; readonly mutationId: string };
type Saved = LocalNoteRef & NoteValues & { readonly revision: number };
export function makeNoteDraft(note: Saved): NoteDraft {
  const { id, projectId, clientScopeKey, title, markdown, revision } = note;
  return {
    id,
    projectId,
    clientScopeKey,
    title,
    markdown,
    base: { title, markdown, revision },
    conflictingRevision: null,
  };
}
export function isDirtyNoteDraft(draft: NoteDraft) {
  return draft.title !== draft.base.title || draft.markdown !== draft.base.markdown;
}
export function beginNoteSave(draft: NoteDraft, mutationId: string): NoteSaveSnapshot | null {
  if (draft.conflictingRevision !== null || !isDirtyNoteDraft(draft) || !draft.title.trim())
    return null;
  return {
    id: draft.id,
    projectId: draft.projectId,
    clientScopeKey: draft.clientScopeKey,
    title: draft.title.trim(),
    markdown: draft.markdown,
    expectedRevision: draft.base.revision,
    mutationId,
  };
}
const matches = (draft: LocalNoteRef, other: LocalNoteRef) =>
  draft.id === other.id &&
  draft.projectId === other.projectId &&
  draft.clientScopeKey === other.clientScopeKey;
export function confirmNoteSave(
  draft: NoteDraft,
  snapshot: NoteSaveSnapshot,
  saved: ProjectNoteMutationResult,
): NoteDraft {
  if (
    saved.id !== snapshot.id ||
    !matches(draft, snapshot) ||
    snapshot.expectedRevision !== draft.base.revision ||
    saved.revision !== snapshot.expectedRevision + 1
  )
    return draft;
  return {
    ...draft,
    title: draft.title.trim() === snapshot.title ? snapshot.title : draft.title,
    base: { title: snapshot.title, markdown: snapshot.markdown, revision: saved.revision },
    conflictingRevision:
      draft.conflictingRevision !== null && draft.conflictingRevision > saved.revision
        ? draft.conflictingRevision
        : null,
  };
}
export function noteSaveConflicted(
  draft: NoteDraft,
  snapshot: NoteSaveSnapshot,
  currentRevision: number,
): NoteDraft {
  if (
    !matches(draft, snapshot) ||
    snapshot.expectedRevision !== draft.base.revision ||
    currentRevision <= draft.base.revision
  )
    return draft;
  return {
    ...draft,
    conflictingRevision: Math.max(draft.conflictingRevision ?? 0, currentRevision),
  };
}
export function resolveNoteConflict(
  draft: NoteDraft,
  latest: Saved,
  chosen: NoteValues,
): NoteDraft {
  if (
    draft.conflictingRevision === null ||
    latest.revision < draft.conflictingRevision ||
    !matches(draft, latest)
  )
    return draft;
  return { ...makeNoteDraft(latest), ...chosen };
}

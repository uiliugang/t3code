import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PROJECT_NOTE_MAX_BYTES = 256 * 1024;
export const PROJECT_NOTE_SEARCH_SCAN_LIMIT = 200;
export const ProjectNoteId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("ProjectNoteId"),
);
export type ProjectNoteId = typeof ProjectNoteId.Type;
const revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const title = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const markdown = Schema.String.check(Schema.isMaxLength(PROJECT_NOTE_MAX_BYTES));
const mutationId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export const ProjectNoteSummary = Schema.Struct({
  id: ProjectNoteId,
  projectId: ProjectId,
  title,
  revision,
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectNoteSummary = typeof ProjectNoteSummary.Type;
export const ProjectNote = Schema.Struct({ ...ProjectNoteSummary.fields, markdown });
export type ProjectNote = typeof ProjectNote.Type;
export const ProjectNoteRef = Schema.Struct({ projectId: ProjectId, id: ProjectNoteId });
export type ProjectNoteRef = typeof ProjectNoteRef.Type;
export const ProjectNoteCursor = Schema.Struct({ updatedAt: IsoDateTime, id: ProjectNoteId });
export type ProjectNoteCursor = typeof ProjectNoteCursor.Type;
export const ProjectNoteListInput = Schema.Struct({
  projectId: ProjectId,
  archived: Schema.Boolean,
  cursor: Schema.optional(ProjectNoteCursor),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
});
export type ProjectNoteListInput = typeof ProjectNoteListInput.Type;
export const ProjectNoteSearchInput = Schema.Struct({
  ...ProjectNoteListInput.fields,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
});
export type ProjectNoteSearchInput = typeof ProjectNoteSearchInput.Type;
export const ProjectNotePage = Schema.Struct({
  notes: Schema.Array(ProjectNoteSummary),
  nextCursor: Schema.NullOr(ProjectNoteCursor),
});
export type ProjectNotePage = typeof ProjectNotePage.Type;
export const ProjectNoteSearchPage = Schema.Struct({
  ...ProjectNotePage.fields,
  scanned: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: PROJECT_NOTE_SEARCH_SCAN_LIMIT }),
  ),
});
export type ProjectNoteSearchPage = typeof ProjectNoteSearchPage.Type;
export const ProjectNoteCreateInput = Schema.Struct({
  projectId: ProjectId,
  title,
  markdown,
  mutationId,
});
export type ProjectNoteCreateInput = typeof ProjectNoteCreateInput.Type;
const versioned = { ...ProjectNoteRef.fields, expectedRevision: revision, mutationId };
export const ProjectNoteUpdateInput = Schema.Struct({ ...versioned, title, markdown });
export type ProjectNoteUpdateInput = typeof ProjectNoteUpdateInput.Type;
export const ProjectNoteSetArchiveInput = Schema.Struct({ ...versioned, archived: Schema.Boolean });
export type ProjectNoteSetArchiveInput = typeof ProjectNoteSetArchiveInput.Type;
export const ProjectNoteMutationResult = Schema.Struct({ id: ProjectNoteId, revision });
export type ProjectNoteMutationResult = typeof ProjectNoteMutationResult.Type;

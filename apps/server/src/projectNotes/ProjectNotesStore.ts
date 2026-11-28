import {
  PROJECT_NOTE_MAX_BYTES,
  PROJECT_NOTE_SEARCH_SCAN_LIMIT,
  ProjectNoteId,
  type ProjectId,
  type ProjectNote,
  type ProjectNoteCreateInput,
  type ProjectNoteCursor,
  type ProjectNoteListInput,
  type ProjectNoteMutationResult,
  type ProjectNotePage,
  type ProjectNoteRef,
  type ProjectNoteSearchInput,
  type ProjectNoteSearchPage,
  type ProjectNoteSetArchiveInput,
  type ProjectNoteSummary,
  type ProjectNoteUpdateInput,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

export class ProjectNotesStoreError extends Schema.TaggedError<
  ProjectNotesStoreError,
  { readonly brand: unique symbol }
>()("ProjectNotesStoreError", {
  reason: Schema.Literals(["unavailable", "conflict", "mutation-reused", "too-large", "storage"]),
  currentRevision: Schema.optional(Schema.Int),
}) {}

declare const notesOwnerKey: unique symbol;
export type ProjectNotesOwnerKey = string & { readonly [notesOwnerKey]: true };
type Result<A> = Effect.Effect<A, ProjectNotesStoreError>;
export class ProjectNotesStore extends Context.Service<
  ProjectNotesStore,
  {
    readonly list: (
      owner: ProjectNotesOwnerKey,
      input: ProjectNoteListInput,
    ) => Result<ProjectNotePage>;
    readonly search: (
      owner: ProjectNotesOwnerKey,
      input: ProjectNoteSearchInput,
    ) => Result<ProjectNoteSearchPage>;
    readonly get: (owner: ProjectNotesOwnerKey, input: ProjectNoteRef) => Result<ProjectNote>;
    readonly create: (
      owner: ProjectNotesOwnerKey,
      input: ProjectNoteCreateInput,
    ) => Result<ProjectNoteMutationResult>;
    readonly update: (
      owner: ProjectNotesOwnerKey,
      input: ProjectNoteUpdateInput,
    ) => Result<ProjectNoteMutationResult>;
    readonly setArchive: (
      owner: ProjectNotesOwnerKey,
      input: ProjectNoteSetArchiveInput,
    ) => Result<ProjectNoteMutationResult>;
  }
>()("t3/projectNotes/ProjectNotesStore") {}

const unavailable = () => new ProjectNotesStoreError({ reason: "unavailable" });
const isStoreError = Schema.is(ProjectNotesStoreError);
const storeError = (e: unknown) =>
  isStoreError(e) ? e : new ProjectNotesStoreError({ reason: "storage" });
const encode = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))),
);
const normalize = (s: string) => s.normalize("NFKC").toLowerCase();
const cursorOf = ({ id, updatedAt }: ProjectNoteSummary): ProjectNoteCursor => ({ id, updatedAt });
const size = (markdown: string) =>
  Buffer.byteLength(markdown, "utf8") > PROJECT_NOTE_MAX_BYTES
    ? Effect.fail(new ProjectNotesStoreError({ reason: "too-large" }))
    : Effect.void;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;
  const columns = sql`note_id AS id, project_id AS "projectId", title, revision, archived_at AS "archivedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;
  const exists = (projectId: ProjectId) =>
    sql`EXISTS (SELECT 1 FROM projection_projects WHERE project_id=${projectId} AND deleted_at IS NULL)`;
  const scope = (owner: ProjectNotesOwnerKey, projectId: ProjectId) =>
    sql`owner_key=${owner} AND project_id=${projectId} AND ${exists(projectId)}`;
  const pageScope = (
    owner: ProjectNotesOwnerKey,
    input: ProjectNoteListInput,
    cursor: ProjectNoteCursor | undefined,
  ) => sql`
  ${scope(owner, input.projectId)} AND ((archived_at IS NOT NULL)=${input.archived ? 1 : 0})
  ${cursor === undefined ? sql`` : sql`AND (updated_at,note_id)<(${cursor.updatedAt},${cursor.id})`}`;
  const get = Effect.fn("ProjectNotesStore.get")(function* (
    owner: ProjectNotesOwnerKey,
    input: ProjectNoteRef,
  ) {
    const [note] =
      yield* sql<ProjectNote>`SELECT ${columns},markdown FROM project_notes WHERE ${scope(owner, input.projectId)} AND note_id=${input.id}`;
    if (!note) return yield* unavailable();
    return note;
  }, Effect.mapError(storeError));
  const list = Effect.fn("ProjectNotesStore.list")(function* (
    owner: ProjectNotesOwnerKey,
    input: ProjectNoteListInput,
  ) {
    const rows =
      yield* sql<ProjectNoteSummary>`SELECT ${columns} FROM project_notes WHERE ${pageScope(owner, input, input.cursor)} ORDER BY updated_at DESC,note_id DESC LIMIT ${input.limit + 1}`;
    const notes = rows.slice(0, input.limit);
    return {
      notes,
      nextCursor: rows.length > input.limit ? cursorOf(notes[input.limit - 1]!) : null,
    };
  }, Effect.mapError(storeError));
  const search = Effect.fn("ProjectNotesStore.search")(
    function* (owner: ProjectNotesOwnerKey, input: ProjectNoteSearchInput) {
      const query = normalize(input.query);
      const notes: ProjectNoteSummary[] = [];
      let cursor = input.cursor;
      let scanned = 0;
      while (scanned < PROJECT_NOTE_SEARCH_SCAN_LIMIT) {
        const limit = Math.min(16, PROJECT_NOTE_SEARCH_SCAN_LIMIT - scanned);
        const rows =
          yield* sql<ProjectNote>`SELECT ${columns},markdown FROM project_notes WHERE ${pageScope(owner, input, cursor)} ORDER BY updated_at DESC,note_id DESC LIMIT ${limit + 1}`;
        for (const [index, { markdown, ...summary }] of rows.slice(0, limit).entries()) {
          scanned++;
          cursor = cursorOf(summary);
          if (normalize(summary.title).includes(query) || normalize(markdown).includes(query))
            notes.push(summary);
          if (notes.length === input.limit)
            return { notes, scanned, nextCursor: rows.length > index + 1 ? cursor : null };
        }
        if (rows.length <= limit) return { notes, scanned, nextCursor: null };
      }
      return { notes, scanned, nextCursor: cursor ?? null };
    },
    (effect) => sql.withTransaction(effect).pipe(NodeSqliteClient.readOnly),
    Effect.mapError(storeError),
  );
  const mutate = Effect.fn("ProjectNotesStore.mutate")(
    function* (
      owner: ProjectNotesOwnerKey,
      input: { readonly projectId: ProjectId; readonly mutationId: string },
      payload: ReadonlyArray<string | number | boolean>,
      write: Effect.Effect<ProjectNoteMutationResult, ProjectNotesStoreError | SqlError>,
    ) {
      const [project] = yield* sql<{
        allowed: number;
      }>`SELECT ${exists(input.projectId)} AS allowed`;
      if (project?.allowed !== 1 || owner.length === 0) return yield* unavailable();
      const encoded = yield* encode(payload);
      const fingerprint = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(encoded));
      const [previous] = yield* sql<ProjectNoteMutationResult & { fingerprint: string }>`
   SELECT note_id AS id,revision,request_fingerprint AS fingerprint FROM project_note_mutations
   WHERE owner_key=${owner} AND project_id=${input.projectId} AND mutation_id=${input.mutationId}
  `;
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          return yield* new ProjectNotesStoreError({ reason: "mutation-reused" });
        return { id: previous.id, revision: previous.revision };
      }
      const updated = yield* write;
      yield* sql`INSERT INTO project_note_mutations (owner_key,project_id,mutation_id,request_fingerprint,note_id,revision) VALUES (${owner},${input.projectId},${input.mutationId},${fingerprint},${updated.id},${updated.revision})`;
      return updated;
    },
    sql.withTransaction,
    Effect.mapError(storeError),
  );
  const create = Effect.fn("ProjectNotesStore.create")(function* (
    owner: ProjectNotesOwnerKey,
    input: ProjectNoteCreateInput,
  ) {
    yield* size(input.markdown);
    return yield* mutate(
      owner,
      input,
      ["create", input.title, input.markdown],
      Effect.gen(function* () {
        const id = ProjectNoteId.make(yield* random.uuidV4().pipe(Effect.mapError(storeError)));
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`INSERT INTO project_notes (note_id,project_id,owner_key,title,markdown,revision,created_at,updated_at) VALUES (${id},${input.projectId},${owner},${input.title},${input.markdown},1,${now},${now})`;
        return { id, revision: 1 };
      }),
    );
  });
  const edit = Effect.fn("ProjectNotesStore.edit")(function* (
    owner: ProjectNotesOwnerKey,
    input: ProjectNoteUpdateInput | ProjectNoteSetArchiveInput,
  ) {
    if ("markdown" in input) yield* size(input.markdown);
    const payload =
      "markdown" in input
        ? ["update", input.id, input.expectedRevision, input.title, input.markdown]
        : ["archive", input.id, input.expectedRevision, input.archived];
    return yield* mutate(
      owner,
      input,
      payload,
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const change =
          "markdown" in input
            ? sql`title=${input.title},markdown=${input.markdown}`
            : sql`archived_at=${input.archived ? now : null}`;
        const [result] =
          yield* sql<ProjectNoteMutationResult>`UPDATE project_notes SET ${change},revision=revision+1,updated_at=${now}
    WHERE ${scope(owner, input.projectId)} AND note_id=${input.id} AND revision=${input.expectedRevision} RETURNING note_id AS id,revision`;
        if (result) return result;
        const [current] = yield* sql<{
          revision: number;
        }>`SELECT revision FROM project_notes WHERE ${scope(owner, input.projectId)} AND note_id=${input.id}`;
        if (!current) return yield* unavailable();
        return yield* new ProjectNotesStoreError({
          reason: "conflict",
          currentRevision: current.revision,
        });
      }),
    );
  });
  return ProjectNotesStore.of({ list, search, get, create, update: edit, setArchive: edit });
});
export const layer = Layer.effect(ProjectNotesStore, make);

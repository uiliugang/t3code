import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { PROJECT_NOTE_MAX_BYTES, ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import migration from "../persistence/Migrations/138_ProjectNotes.ts";
import {
  ProjectNotesStore,
  layer as notesLayer,
  type ProjectNotesOwnerKey,
} from "./ProjectNotesStore.ts";

const projectId = ProjectId.make("real");
const other = ProjectId.make("other");
const owner = "owner" as ProjectNotesOwnerKey;
const guest = "guest" as ProjectNotesOwnerKey;
const fixture = notesLayer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  Layer.provide(NodeCrypto.layer),
);
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, deleted_at TEXT)`;
  yield* sql`INSERT INTO projection_projects (project_id) VALUES (${projectId}),(${other})`;
  yield* migration;
});
const first = {
  projectId,
  title: "原始笔记",
  markdown: "Keep ｔ３ source\r\n",
  mutationId: "create",
};
const list = { projectId, archived: false, limit: 20 };

it.effect(
  "persists idempotently, isolates owner and project, and suppresses deleted projects",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const store = yield* ProjectNotesStore;
      const sql = yield* SqlClient.SqlClient;
      const created = yield* store.create(owner, first);
      assert.deepEqual(yield* store.create(owner, first), created);
      assert.equal(
        (yield* Effect.flip(store.create(owner, { ...first, markdown: "different" }))).reason,
        "mutation-reused",
      );
      assert.deepEqual((yield* store.list(guest, list)).notes, []);
      assert.equal(
        (yield* Effect.flip(store.get(owner, { projectId: other, id: created.id }))).reason,
        "unavailable",
      );
      assert.equal(
        (yield* Effect.flip(store.get(guest, { projectId, id: created.id }))).reason,
        "unavailable",
      );
      assert.equal((yield* store.search(owner, { ...list, query: "笔" })).notes[0]?.id, created.id);
      assert.equal((yield* store.search(owner, { ...list, query: "T3" })).notes[0]?.id, created.id);
      yield* sql`UPDATE projection_projects SET deleted_at='deleted' WHERE project_id=${projectId}`;
      assert.deepEqual((yield* store.list(owner, list)).notes, []);
      assert.equal(
        (yield* Effect.flip(store.get(owner, { projectId, id: created.id }))).reason,
        "unavailable",
      );
    }).pipe(Effect.provide(fixture)),
);

it.effect(
  "serializes concurrent saves at the same revision and preserves raw Markdown through archive",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const store = yield* ProjectNotesStore;
      const { id } = yield* store.create(owner, first);
      const save = (markdown: string) =>
        store
          .update(owner, { ...first, id, expectedRevision: 1, markdown, mutationId: markdown })
          .pipe(
            Effect.match({
              onSuccess: (result) => ({ result, markdown }) as const,
              onFailure: (error) => ({ error }) as const,
            }),
          );
      const results = yield* Effect.all([save("web"), save("原文\r\n")], {
        concurrency: "unbounded",
      });
      const [winner] = results.filter((result) => "result" in result);
      assert.equal(results.filter((result) => "result" in result).length, 1);
      assert.equal(results.find((result) => "error" in result)?.error.reason, "conflict");
      assert.equal(winner?.result.revision, 2);
      const archived = yield* store.setArchive(owner, {
        projectId,
        id,
        expectedRevision: 2,
        mutationId: "archive",
        archived: true,
      });
      assert.deepEqual((yield* store.list(owner, list)).notes, []);
      assert.equal((yield* store.list(owner, { ...list, archived: true })).notes[0]?.id, id);
      yield* store.setArchive(owner, {
        projectId,
        id,
        expectedRevision: archived.revision,
        mutationId: "restore",
        archived: false,
      });
      assert.equal((yield* store.get(owner, { projectId, id })).markdown, winner?.markdown);
    }).pipe(Effect.provide(fixture)),
);

it.effect("enforces UTF-8 byte budget without applying a partial write", () =>
  Effect.gen(function* () {
    yield* setup;
    const store = yield* ProjectNotesStore;
    const markdown = "汉".repeat(Math.floor(PROJECT_NOTE_MAX_BYTES / 3)) + "x";
    const { id } = yield* store.create(owner, { ...first, markdown });
    assert.equal(
      Buffer.byteLength((yield* store.get(owner, { projectId, id })).markdown),
      PROJECT_NOTE_MAX_BYTES,
    );
    const failed = yield* Effect.flip(
      store.update(owner, {
        ...first,
        id,
        expectedRevision: 1,
        markdown: markdown + "🚀",
        mutationId: "too-large",
      }),
    );
    assert.equal(failed.reason, "too-large");
    assert.equal((yield* store.get(owner, { projectId, id })).revision, 1);
  }).pipe(Effect.provide(fixture)),
);

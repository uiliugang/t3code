import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_notes (
      note_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_key TEXT NOT NULL,
      title TEXT NOT NULL, markdown TEXT NOT NULL CHECK(length(CAST(markdown AS BLOB)) <= 262144),
      revision INTEGER NOT NULL CHECK(revision >= 1), archived_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_notes_scope_updated
    ON project_notes (owner_key, project_id, updated_at DESC, note_id DESC)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_note_mutations (
      owner_key TEXT NOT NULL, project_id TEXT NOT NULL, mutation_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL, note_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      PRIMARY KEY (owner_key, project_id, mutation_id)
    )
  `;
});

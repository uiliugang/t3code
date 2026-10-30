import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE managed_worktree_snapshots (
    group_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL
  )`;
});

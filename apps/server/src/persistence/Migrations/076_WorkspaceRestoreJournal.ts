import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workspace_restores (
    thread_id TEXT PRIMARY KEY,
    stage TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`;
});

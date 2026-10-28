import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workspace_cleanup_resources (
    revision_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    PRIMARY KEY (revision_id, resource_id)
  )`;
});

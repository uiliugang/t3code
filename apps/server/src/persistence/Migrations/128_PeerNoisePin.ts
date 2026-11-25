import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(peer_environment_links)`;
  if (!columns.some((column) => column.name === "noise_pin")) {
    yield* sql`ALTER TABLE peer_environment_links ADD COLUMN noise_pin TEXT`;
  }
});

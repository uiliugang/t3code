import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_connect_devices)`;
  if (!columns.some((column) => column.name === "noise_approved_at")) {
    yield* sql`ALTER TABLE auth_connect_devices ADD COLUMN noise_approved_at TEXT`;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_pairing_links_pending_device ON auth_pairing_links(proof_key_thumbprint, expires_at)
    WHERE consumed_at IS NULL AND requires_connect_approval = 1
  `;
});

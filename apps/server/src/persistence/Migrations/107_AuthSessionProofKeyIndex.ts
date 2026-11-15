import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS auth_sessions_proof_key_issued_idx
    ON auth_sessions(proof_key_thumbprint, issued_at)`;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_provider_turns_completed_at_idx
    ON orchestration_v2_projection_provider_turns(completed_at)
    WHERE status = 'completed'
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS agent_feedback`;
  yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE type = 'feedback_request'`;
  yield* sql`DELETE FROM orchestration_v2_events
    WHERE event_type = 'turn-item.updated'
      AND json_extract(payload_json, '$.type') = 'feedback_request'`;
  yield* sql`DELETE FROM orchestration_events
    WHERE application_event_version = 2
      AND aggregate_kind = 'thread'
      AND event_type = 'turn-item.updated'
      AND json_extract(payload_json, '$.type') = 'feedback_request'`;
});

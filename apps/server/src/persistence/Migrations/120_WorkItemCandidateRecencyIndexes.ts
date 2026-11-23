import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_work_item_candidates_recency
    ON work_item_candidates(json_extract(candidate_json, '$.updatedAt') DESC, thread_id DESC)
    WHERE json_valid(candidate_json)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_work_item_candidates_project_recency
    ON work_item_candidates(project_id, json_extract(candidate_json, '$.updatedAt') DESC, thread_id DESC)
    WHERE json_valid(candidate_json)
  `;
});

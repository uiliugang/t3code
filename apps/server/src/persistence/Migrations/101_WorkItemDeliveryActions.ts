import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE work_item_delivery_actions (work_item_id TEXT NOT NULL, scope_revision INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY (work_item_id, scope_revision, kind))`;
  yield* sql`CREATE TABLE work_item_issue_projects (work_item_id TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY (work_item_id, project_id))`;
  yield* sql`CREATE INDEX idx_work_item_issue_projects ON work_item_issue_projects(project_id, work_item_id)`;
  yield* sql`CREATE UNIQUE INDEX idx_work_items_issue ON work_items(json_extract(item_json, '$.delivery.issue.url')) WHERE json_extract(item_json, '$.delivery.issue.url') IS NOT NULL`;
});

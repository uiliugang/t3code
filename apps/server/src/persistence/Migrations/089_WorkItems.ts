import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE work_items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, updated_at TEXT NOT NULL, active_count INTEGER NOT NULL, item_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX idx_work_items_project ON work_items(project_id, updated_at DESC)`;
  yield* sql`CREATE INDEX idx_work_items_active ON work_items(active_count) WHERE active_count > 0`;
  yield* sql`CREATE TABLE work_item_commands (command_id TEXT PRIMARY KEY, input_json TEXT NOT NULL, result_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE work_item_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id TEXT NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX idx_work_item_events_item ON work_item_events(work_item_id, sequence)`;
  yield* sql`CREATE TABLE work_item_outbox (execution_id TEXT NOT NULL, work_item_id TEXT NOT NULL, effect_type TEXT NOT NULL, command_id TEXT NOT NULL, caller_thread_id TEXT, PRIMARY KEY(execution_id, effect_type))`;
  yield* sql`CREATE TABLE work_item_discovery (project_id TEXT PRIMARY KEY)`;
  yield* sql`CREATE TABLE work_item_candidates (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, candidate_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE work_item_ignored (thread_id TEXT PRIMARY KEY, source_updated_at TEXT NOT NULL)`;
});

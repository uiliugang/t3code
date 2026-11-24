import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("126_RemoveAgentFeedback", (it) => {
  it.effect("removes old reports and cards without removing other turn items or events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 125 });
      yield* sql`INSERT INTO agent_feedback
        (id, created_at, kind, subject, expected, actual, workaround, source)
        VALUES ('report', '2026-11-19', 'bug', 'T3', '', '', '', 'mcp')`;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
        VALUES
          ('card', 'thread', 1, 'feedback_request', 'waiting', '2026-11-19', '{}'),
          ('message', 'thread', 2, 'assistant_message', 'completed', '2026-11-19', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_events
        (event_id, thread_id, event_type, occurred_at, payload_json)
        VALUES
          ('card-opened', 'thread', 'turn-item.updated', '2026-11-19', '{"type":"feedback_request"}'),
          ('message', 'thread', 'turn-item.updated', '2026-11-19', '{"type":"assistant_message"}'),
          ('card-answered', 'thread', 'turn-item.updated', '2026-11-19', '{"type":"feedback_request"}')`;
      yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
         actor_kind, payload_json, metadata_json, application_event_version)
        VALUES
          ('card-opened', 'thread', 'thread', 0, 'turn-item.updated', '2026-11-19',
           'server', '{"type":"feedback_request","preview":{"actual":"report text"}}', '{}', 2),
          ('message', 'thread', 'thread', 1, 'turn-item.updated', '2026-11-19',
           'provider', '{"type":"assistant_message"}', '{}', 2),
          ('card-answered', 'thread', 'thread', 2, 'turn-item.updated', '2026-11-19',
           'server', '{"type":"feedback_request"}', '{}', 2)`;

      yield* runMigrations();

      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_schema WHERE name = 'agent_feedback'`,
        [],
      );
      assert.deepEqual(
        yield* sql`SELECT turn_item_id FROM orchestration_v2_projection_turn_items`,
        [{ turn_item_id: "message" }],
      );
      assert.deepEqual(yield* sql`SELECT sequence, event_id FROM orchestration_v2_events`, [
        { sequence: 2, event_id: "message" },
      ]);
      assert.deepEqual(yield* sql`SELECT sequence, event_id FROM orchestration_events`, [
        { sequence: 2, event_id: "message" },
      ]);
      assert.deepEqual(
        yield* sql`SELECT item_count FROM orchestration_v2_projection_thread_item_counts`,
        [{ item_count: 1 }],
      );
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { readPendingHumanActions, subscribePendingHumanActions } from "./PendingHumanActions.ts";

const layer = Events.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.live("enumerates exact live cards and replays a resolution committed before subscription", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const time = "2026-11-22T12:00:00.000Z";
    const insertThread = (id: string, extra: Record<string, unknown> = {}) => sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES (${id}, 'project', ${id}, 'codex', 'full-access', 'default', ${time}, ${time}, ${JSON.stringify({ lineage: { relationshipToParent: null }, ...extra })})
    `;
    const request = (thread: string, id: string, capability: string, kind = "user_input") => sql`
      INSERT INTO orchestration_v2_projection_runtime_requests (
        runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json
      ) VALUES (${id}, ${thread}, ${id}, ${kind}, 'pending', ${time},
        ${JSON.stringify({ responseCapability: { type: capability } })})
    `;
    const card = (thread: string, id: string, node: string, kind = "user_input_request") => sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, node_id, type, status, ordinal, updated_at, payload_json
      ) VALUES (${id}, ${thread}, ${node}, ${kind}, 'waiting', 1, ${time}, ${JSON.stringify({ requestId: node })})
    `;
    yield* insertThread("source");
    yield* insertThread("other");
    yield* insertThread("side", { lineage: { sideChat: true, relationshipToParent: "fork" } });
    yield* insertThread("coordinator-child", { lineage: { relationshipToParent: "subagent" } });
    yield* insertThread("linked", { delegatedFrom: { threadId: "remote" } });
    yield* insertThread("host-link", { linkOrigin: { environmentId: "remote" } });
    yield* request("source", "question", "message");
    yield* card("source", "question-card", "question");
    yield* request("source", "approval", "live", "command");
    yield* card("source", "approval-card", "approval", "approval_request");
    yield* request("source", "missing", "live");
    yield* request("source", "cross-thread", "live");
    yield* card("other", "wrong-owner", "cross-thread");
    yield* request("source", "non-resumable", "not_resumable");
    yield* card("source", "obsolete", "non-resumable");
    yield* request("source", "wrong-kind", "live", "auth_refresh");
    yield* card("source", "wrong-kind-card", "wrong-kind", "approval_request");
    yield* request("side", "side-question", "live");
    yield* card("side", "side-card", "side-question");
    yield* request("coordinator-child", "managed", "live");
    yield* card("coordinator-child", "managed-card", "managed");
    for (const thread of ["linked", "host-link"]) {
      yield* request(thread, thread, "live");
      yield* card(thread, `${thread}-card`, thread);
    }
    const initial = yield* readPendingHumanActions();
    assert.deepEqual(
      initial.targets.map((item) => [item.threadId, item.requestId, item.targetItemId, item.kind]),
      [
        ["source", "approval", "approval-card", "approval"],
        ["source", "question", "question-card", "user_input"],
        ["side", "side-question", "side-card", "user_input"],
      ],
    );
    const subscription = yield* subscribePendingHumanActions();
    yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved' WHERE runtime_request_id = 'question'`;
    yield* sql`UPDATE orchestration_v2_projection_turn_items SET status = 'completed' WHERE turn_item_id = 'approval-card'`;
    const event = yield* sql<{ readonly sequence: number }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        'resolved-question', 'thread', 'source', 1, 'runtime-request.updated',
        ${time}, 'server',
        ${JSON.stringify({
          id: "question",
          nodeId: "question",
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "resolved",
          responseCapability: { type: "message" },
          createdAt: time,
          resolvedAt: time,
        })}, '{}', 2
      ) RETURNING sequence
    `;
    const frames = yield* subscription.pipe(Stream.take(2), Stream.runCollect);
    assert.equal(frames[0]?.sequence, initial.sequence);
    assert.equal(frames[1]?.sequence, event[0]?.sequence);
    assert.deepEqual(
      frames[1]?.targets.map((item) => item.requestId),
      ["side-question"],
    );

    const updated = yield* readPendingHumanActions();
    assert.deepEqual(
      updated.targets.map((item) => item.requestId),
      ["side-question"],
    );
  }).pipe(Effect.provide(layer)),
);

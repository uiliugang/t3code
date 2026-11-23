import {
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2PendingHumanActionSnapshot,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";

const decodeSnapshot = Schema.decodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2PendingHumanActionSnapshot),
);

// Only requests with their own outstanding card qualify. Shell flags can refer to child
// work and are not source identities. Linked dispatches and coordinator-owned subagents
// stay in their own surfaces instead of being inferred to need the current user.
export const readPendingHumanActions = Effect.fn("PendingHumanActions.read")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const snapshot = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const sequence = yield* events.latestApplicationSequence;
        const targets = yield* sql`
      SELECT thread.thread_id AS threadId, thread.project_id AS projectId,
             request.runtime_request_id AS requestId, card.turn_item_id AS targetItemId,
             CASE WHEN request.kind = 'user_input' THEN 'user_input' ELSE 'approval' END AS kind,
             request.created_at AS createdAt
      FROM orchestration_v2_projection_threads AS thread
      CROSS JOIN orchestration_v2_projection_runtime_requests AS request
        INDEXED BY orchestration_v2_projection_runtime_requests_thread_status_idx
      CROSS JOIN orchestration_v2_projection_turn_items AS card
        INDEXED BY orchestration_v2_projection_turn_items_node_ordinal_idx
      WHERE thread.archived_at IS NULL AND thread.deleted_at IS NULL
        AND json_extract(thread.payload_json, '$.linkOrigin') IS NULL
        AND json_extract(thread.payload_json, '$.delegatedFrom') IS NULL
        AND json_type(thread.payload_json, '$.lineage.relationshipToParent') IN ('null', 'text')
        AND (
          json_extract(thread.payload_json, '$.lineage.relationshipToParent') IS NULL
          OR json_extract(thread.payload_json, '$.lineage.relationshipToParent') = 'fork'
          OR (json_extract(thread.payload_json, '$.lineage.relationshipToParent') = 'subagent'
              AND json_extract(thread.payload_json, '$.lineage.sideChat') = 1)
        )
        AND NOT (
          json_extract(thread.payload_json, '$.lineage.relationshipToParent') IS 'subagent'
          AND json_extract(thread.payload_json, '$.creationSource') IS 'provider'
        )
        AND request.thread_id = thread.thread_id AND request.status = 'pending'
        AND request.kind IN ('user_input', 'command', 'file-read', 'file-change', 'mcp-elicitation', 'permission')
        AND (
          json_extract(request.payload_json, '$.responseCapability.type') = 'live'
          OR (request.kind = 'user_input'
            AND json_extract(request.payload_json, '$.responseCapability.type') = 'message')
        )
        AND card.node_id = request.node_id AND card.thread_id = request.thread_id
        AND card.status IN ('waiting', 'pending')
        AND card.type = CASE WHEN request.kind = 'user_input' THEN 'user_input_request' ELSE 'approval_request' END
        AND json_extract(card.payload_json, '$.requestId') = request.runtime_request_id
      ORDER BY request.created_at, request.runtime_request_id, card.ordinal DESC
    `;
        return { sequence, targets };
      }),
    )
    .pipe(NodeSqliteClient.readOnly);
  return yield* decodeSnapshot(snapshot);
});

export const subscribePendingHumanActions = Effect.fn("PendingHumanActions.subscribe")(
  function* () {
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const load = () =>
      readPendingHumanActions().pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetShellSnapshotError({
              message: "Failed to read pending human actions",
              cause,
            }),
        ),
      );
    const initial = yield* load();
    const updates = events.streamApplicationEvents({ afterSequence: initial.sequence }).pipe(
      Stream.filter(
        (event) =>
          "event" in event &&
          (event.event.type === "runtime-request.updated" ||
            (event.event.type === "turn-item.updated" &&
              (event.event.payload.type === "approval_request" ||
                event.event.payload.type === "user_input_request")) ||
            event.event.type.startsWith("thread.")),
      ),
      Stream.groupedWithin(64, "25 millis"),
      Stream.mapEffect(() => load()),
      Stream.mapError(
        (cause) =>
          new OrchestrationV2GetShellSnapshotError({
            message: "Failed to stream pending human actions",
            cause,
          }),
      ),
    );
    return Stream.concat(Stream.succeed(initial), updates);
  },
);

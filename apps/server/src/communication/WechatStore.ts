import {
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  WechatDelivery,
  WechatError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const Connection = Schema.Struct({
  activationMessageId: Schema.optional(Schema.String),
  generation: Schema.String,
  enabled: Schema.Boolean,
  activated: Schema.Boolean,
  botId: Schema.String,
  userId: Schema.String,
  baseUrl: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  projectId: Schema.NullOr(ProjectId),
  pushEnabled: Schema.Boolean,
  pushAllThreads: Schema.Boolean,
  cursor: Schema.String,
  sequence: Schema.Number,
  enabledAt: Schema.Number,
});
export type Connection = typeof Connection.Type;
export const Incoming = Schema.Struct({ id: Schema.String, text: Schema.String });
const Pending = Schema.Struct({
  id: Schema.String,
  generation: Schema.String,
  payload: Schema.String,
});
const DeliveryRequest = Schema.Struct({ threadId: ThreadId, requestId: RuntimeRequestId });
const DeliveryRow = Schema.Struct({
  id: Schema.String,
  generation: Schema.String,
  text: Schema.String,
  status: WechatDelivery.fields.status,
  created_at: Schema.Number,
  attempts: Schema.Number,
  next_at: Schema.Number,
  request: Schema.NullOr(Schema.fromJsonString(DeliveryRequest)),
});
type DeliveryRow = typeof DeliveryRow.Type;
type DeliveryRequest = typeof DeliveryRequest.Type;
const encodeDeliveryRequest = Schema.encodeEffect(Schema.fromJsonString(DeliveryRequest));
const decodeDeliveries = Schema.decodeUnknownEffect(Schema.Array(DeliveryRow));
const decodeConnection = Schema.decodeEffect(Schema.fromJsonString(Connection));
const encodeConnection = Schema.encodeEffect(Schema.fromJsonString(Connection));
const encodeIncoming = Schema.encodeEffect(Schema.fromJsonString(Incoming));

export class WechatStore extends Context.Service<
  WechatStore,
  {
    readonly connection: Effect.Effect<Connection | null, WechatError>;
    readonly save: (connection: Connection) => Effect.Effect<void, WechatError>;
    readonly clear: Effect.Effect<void, WechatError>;
    readonly receive: (
      generation: string,
      messages: ReadonlyArray<typeof Incoming.Type>,
      cursor: string,
    ) => Effect.Effect<void, WechatError>;
    readonly inbox: (
      generation: string,
    ) => Effect.Effect<ReadonlyArray<typeof Pending.Type>, WechatError>;
    readonly complete: (id: string) => Effect.Effect<void, WechatError>;
    readonly enqueue: (
      generation: string,
      id: string,
      text: string,
      now: number,
      request?: DeliveryRequest,
    ) => Effect.Effect<void, WechatError>;
    readonly pending: (
      generation: string,
      now: number,
    ) => Effect.Effect<ReadonlyArray<DeliveryRow>, WechatError>;
    readonly deliveries: (
      generation: string,
    ) => Effect.Effect<ReadonlyArray<DeliveryRow>, WechatError>;
    readonly updateDelivery: (
      id: string,
      status: (typeof WechatDelivery.Type)["status"],
      nextAt?: number,
    ) => Effect.Effect<void, WechatError>;
    readonly discardRequest: (
      generation: string,
      requestId: RuntimeRequestId,
    ) => Effect.Effect<void, WechatError>;
    readonly pause: (generation: string) => Effect.Effect<void, WechatError>;
    readonly recover: Effect.Effect<void, WechatError>;
    readonly lease: (owner: string, now: number) => Effect.Effect<boolean, WechatError>;
    readonly release: (owner: string) => Effect.Effect<void, WechatError>;
  }
>()("t3/communication/WechatStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const storageError = () => new WechatError({ reason: "storage" });
  const connection = sql<{
    payload: string;
  }>`SELECT payload FROM wechat_connection WHERE id = 1`.pipe(
    Effect.flatMap((rows) => (rows[0] ? decodeConnection(rows[0].payload) : Effect.succeed(null))),
    Effect.mapError(storageError),
  );
  return WechatStore.of({
    connection,
    save: Effect.fn("WechatStore.save")(function* (value) {
      const payload = yield* encodeConnection(value);
      yield* sql`INSERT INTO wechat_connection (id, payload) VALUES (1, ${payload}) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`;
    }, Effect.mapError(storageError)),
    clear: sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM wechat_connection`;
          yield* sql`DELETE FROM wechat_inbox`;
          yield* sql`DELETE FROM wechat_deliveries`;
        }),
      )
      .pipe(Effect.asVoid, Effect.mapError(storageError)),
    receive: Effect.fn("WechatStore.receive")(function* (generation, messages, cursor) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const message of messages) {
            const payload = yield* encodeIncoming(message);
            yield* sql`INSERT OR IGNORE INTO wechat_inbox (id, generation, payload, done)
            VALUES (${`${generation}:${message.id}`}, ${generation}, ${payload}, 0)`;
          }
          yield* sql`UPDATE wechat_connection SET payload = json_set(payload, '$.cursor', ${cursor})
          WHERE json_extract(payload, '$.generation') = ${generation}`;
        }),
      );
    }, Effect.mapError(storageError)),
    inbox: Effect.fn("WechatStore.inbox")((generation: string) =>
      sql<typeof Pending.Type>`
      SELECT id, generation, payload FROM wechat_inbox WHERE generation = ${generation} AND done = 0 ORDER BY rowid LIMIT 50
    `.pipe(Effect.mapError(storageError)),
    ),
    complete: Effect.fn("WechatStore.complete")((id: string) =>
      sql`UPDATE wechat_inbox SET done = 1, payload = '{}' WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(storageError),
      ),
    ),
    enqueue: Effect.fn("WechatStore.enqueue")(function* (generation, id, text, now, request) {
      const requestJson = request === undefined ? null : yield* encodeDeliveryRequest(request);
      // Stable ids keep replayed terminal events from creating another notification.
      const chunks = Array.from(text).reduce<string[]>((parts, char) => {
        const last = parts.length - 1;
        if (last < 0 || parts[last]!.length >= 3500) parts.push(char);
        else parts[last] += char;
        return parts;
      }, []);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const [index, chunk] of chunks.entries())
            yield* sql`
          INSERT OR IGNORE INTO wechat_deliveries (id, generation, text, status, created_at, attempts, next_at, request_json)
          VALUES (${`${generation}:${id}:${index}`}, ${generation}, ${chunk}, 'pending', ${now}, 0, 0, ${requestJson})`;
          yield* sql`DELETE FROM wechat_deliveries WHERE id IN (
          SELECT id FROM wechat_deliveries WHERE status = 'sent' ORDER BY rowid DESC LIMIT -1 OFFSET 50)`;
        }),
      );
    }, Effect.mapError(storageError)),
    pending: Effect.fn("WechatStore.pending")((generation: string, now: number) =>
      sql`
      SELECT *, request_json AS request FROM wechat_deliveries WHERE generation = ${generation} AND status = 'pending' AND next_at <= ${now} ORDER BY rowid LIMIT 1
    `.pipe(Effect.flatMap(decodeDeliveries), Effect.mapError(storageError)),
    ),
    deliveries: Effect.fn("WechatStore.deliveries")((generation: string) =>
      sql`
      SELECT *, request_json AS request FROM wechat_deliveries WHERE generation = ${generation} ORDER BY rowid DESC LIMIT 50
    `.pipe(Effect.flatMap(decodeDeliveries), Effect.mapError(storageError)),
    ),
    updateDelivery: Effect.fn("WechatStore.updateDelivery")(
      (id: string, status: (typeof WechatDelivery.Type)["status"], nextAt = 0) =>
        sql`
      UPDATE wechat_deliveries SET status = ${status}, next_at = ${nextAt}, attempts = attempts + ${status === "sending" ? 1 : 0} WHERE id = ${id}
    `.pipe(Effect.asVoid, Effect.mapError(storageError)),
    ),
    discardRequest: Effect.fn("WechatStore.discardRequest")((generation, requestId) =>
      sql`DELETE FROM wechat_deliveries WHERE generation = ${generation} AND status = 'pending'
        AND json_extract(request_json, '$.requestId') = ${requestId}`.pipe(
        Effect.asVoid,
        Effect.mapError(storageError),
      ),
    ),
    pause: Effect.fn("WechatStore.pause")((generation: string) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE wechat_inbox SET done = 1, payload = '{}' WHERE generation = ${generation}`;
            yield* sql`UPDATE wechat_deliveries SET status = 'failed' WHERE generation = ${generation} AND status = 'pending'`;
          }),
        )
        .pipe(Effect.asVoid, Effect.mapError(storageError)),
    ),
    recover: sql`UPDATE wechat_deliveries SET status = 'unknown' WHERE status = 'sending'`.pipe(
      Effect.asVoid,
      Effect.mapError(storageError),
    ),
    lease: Effect.fn("WechatStore.lease")(function* (owner, now) {
      yield* sql`INSERT OR IGNORE INTO wechat_lease (id, owner, expires_at) VALUES (1, '', 0)`;
      const rows = yield* sql`UPDATE wechat_lease SET owner = ${owner}, expires_at = ${now + 120000}
        WHERE id = 1 AND (owner = ${owner} OR expires_at <= ${now}) RETURNING id`;
      return rows.length === 1;
    }, Effect.mapError(storageError)),
    release: Effect.fn("WechatStore.release")((owner: string) =>
      sql`UPDATE wechat_lease SET expires_at = 0 WHERE owner = ${owner}`.pipe(
        Effect.asVoid,
        Effect.mapError(storageError),
      ),
    ),
  });
});
export const layer = Layer.effect(WechatStore, make);

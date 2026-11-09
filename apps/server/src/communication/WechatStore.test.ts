import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Store from "./WechatStore.ts";
import { RuntimeRequestId, ThreadId } from "@t3tools/contracts";

it.effect("persists an inbox before the cursor, deduplicates replays and fences consumers", () =>
  Effect.gen(function* () {
    const store = yield* Store.WechatStore;
    const sql = yield* SqlClient.SqlClient;
    assert.isTrue(yield* store.lease("first", 0));
    assert.isFalse(yield* store.lease("second", 1));
    yield* store.release("first");
    assert.isTrue(yield* store.lease("second", 1));
    yield* sql`DELETE FROM wechat_lease`;
    assert.isTrue(yield* store.lease("after-clone", 0));
    yield* sql`INSERT INTO wechat_connection (id, payload) VALUES (1, '{"generation":"g","cursor":""}')`;
    for (let n = 0; n < 2; n++)
      yield* store.receive("g", [{ id: "message", text: "hello" }], "after");
    assert.equal((yield* store.inbox("g")).length, 1);
    assert.equal(
      (yield* sql<{
        cursor: string;
      }>`SELECT json_extract(payload, '$.cursor') AS cursor FROM wechat_connection`)[0]?.cursor,
      "after",
    );
    yield* store.complete("g:message");
    assert.equal((yield* store.inbox("g")).length, 0);
  }).pipe(Effect.provide(Store.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "retains proactive deliveries, deduplicates terminal events and recovers ambiguous sends",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.WechatStore;
      yield* store.enqueue("g", "run:1", "result", 1);
      yield* store.enqueue("g", "run:1", "result", 2);
      let rows = yield* store.deliveries("g");
      assert.equal(rows.length, 1);
      assert.isNull(rows[0]?.request);
      yield* store.updateDelivery(rows[0]!.id, "sending");
      yield* store.recover;
      rows = yield* store.deliveries("g");
      assert.equal(rows[0]?.status, "unknown");
      assert.equal(rows[0]?.attempts, 1);
      yield* store.enqueue("g", "later", "notification", 3);
      yield* store.pause("g");
      assert.equal(
        (yield* store.deliveries("g")).find((row) => row.id.includes("later"))?.status,
        "failed",
      );
      const request = {
        threadId: ThreadId.make("thread"),
        requestId: RuntimeRequestId.make("request"),
      };
      yield* store.enqueue("g", "request", "x".repeat(3501), 4, request);
      const chunks = (yield* store.deliveries("g")).filter((row) => row.request !== null);
      assert.equal(chunks.length, 2);
      for (const chunk of chunks) assert.deepEqual(chunk.request, request);
      yield* store.updateDelivery(chunks[0]!.id, "sent");
      yield* store.enqueue("other", "request", "other generation", 5, request);
      yield* store.enqueue("g", "unrelated", "manual push", 6);
      yield* store.discardRequest("g", request.requestId);
      const remaining = yield* store.deliveries("g");
      assert.deepEqual(
        remaining.filter((row) => row.request !== null).map((row) => row.status),
        ["sent"],
      );
      assert.isTrue(remaining.some((row) => row.text === "manual push"));
      assert.equal((yield* store.deliveries("other")).length, 1);
    }).pipe(Effect.provide(Store.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

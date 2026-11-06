import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE wechat_connection (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL)`;
  yield* sql`CREATE TABLE wechat_inbox (id TEXT PRIMARY KEY, generation TEXT NOT NULL, payload TEXT NOT NULL, done INTEGER NOT NULL)`;
  yield* sql`CREATE INDEX wechat_inbox_pending ON wechat_inbox(generation, done)`;
  yield* sql`CREATE TABLE wechat_deliveries (id TEXT PRIMARY KEY, generation TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE wechat_lease (id INTEGER PRIMARY KEY CHECK(id = 1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL)`;
  yield* sql`INSERT INTO wechat_lease VALUES (1, '', 0)`;
});

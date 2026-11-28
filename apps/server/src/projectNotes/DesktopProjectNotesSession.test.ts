import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  DESKTOP_PROJECT_NOTES_FRAME_MAX_BYTES,
  DesktopProjectNotesReply,
  DesktopProjectNotesRequest,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { makeDesktopProjectNotesSession } from "./DesktopProjectNotesSession.ts";
import { layer as notesLayer } from "./ProjectNotesStore.ts";
import migration from "../persistence/Migrations/138_ProjectNotes.ts";

const fixture = notesLayer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  Layer.provide(NodeCrypto.layer),
);
const environmentId = EnvironmentId.make("native");
const projectId = ProjectId.make("real");
const nonce = "a".repeat(64);
const encode = Schema.encodeSync(Schema.fromJsonString(DesktopProjectNotesRequest));
const reply = Schema.decodeSync(Schema.fromJsonString(DesktopProjectNotesReply));
const read = (bytes: Uint8Array) => reply(new TextDecoder().decode(bytes));
const hello = encode({ _tag: "open", version: 1, nonce });
const create = encode({
  _tag: "call",
  version: 1,
  requestId: "create",
  call: {
    _tag: "create",
    input: { projectId, title: "Synthetic", markdown: "Private text", mutationId: "once" },
  },
});
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY,deleted_at TEXT)`;
  yield* sql`INSERT INTO projection_projects (project_id) VALUES (${projectId})`;
  yield* migration;
  return sql;
});

it.effect(
  "rejects pre-handshake, incorrect nonce, injected owner keys and oversize before writing",
  () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      for (const bad of [create, hello.replace(nonce, "b".repeat(64))]) {
        const session = yield* makeDesktopProjectNotesSession({
          launchNonce: nonce,
          environmentId,
        });
        assert.equal((yield* Effect.exit(session.handle(bad)))._tag, "Failure");
        assert.equal((yield* Effect.exit(session.handle(hello)))._tag, "Failure");
      }
      for (const bad of [
        create.replace('"markdown":', '"ownerKey":"foreign","markdown":'),
        " ".repeat(DESKTOP_PROJECT_NOTES_FRAME_MAX_BYTES),
        create + "\n" + create,
      ]) {
        const session = yield* makeDesktopProjectNotesSession({
          launchNonce: nonce,
          environmentId,
        });
        yield* session.handle(hello);
        assert.equal((yield* Effect.exit(session.handle(bad)))._tag, "Failure");
      }
      assert.deepEqual(yield* sql`SELECT note_id FROM project_notes`, []);
    }).pipe(Effect.provide(fixture)),
);

it.effect("binds a ready owner session to the local host and rejects cross-project reads", () =>
  Effect.gen(function* () {
    yield* setup;
    const session = yield* makeDesktopProjectNotesSession({ launchNonce: nonce, environmentId });
    assert.deepEqual(read(yield* session.handle(hello)), {
      _tag: "ready",
      version: 1,
      environmentId,
    });
    const saved = read(yield* session.handle(create));
    if (saved._tag !== "result" || saved.result._tag !== "create")
      return assert.fail("expected a create result");
    const redact = encode({
      _tag: "call",
      version: 1,
      requestId: "foreign",
      call: {
        _tag: "get",
        input: { projectId: ProjectId.make("foreign"), id: saved.result.value.id },
      },
    });
    assert.deepEqual(read(yield* session.handle(redact)), {
      _tag: "failure",
      version: 1,
      requestId: "foreign",
      failure: { reason: "unavailable" },
    });
    yield* session.close;
    assert.equal((yield* Effect.exit(session.handle(hello)))._tag, "Failure");
  }).pipe(Effect.provide(fixture)),
);

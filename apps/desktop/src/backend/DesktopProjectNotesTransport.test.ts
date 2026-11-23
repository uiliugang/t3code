import { assert, it } from "@effect/vitest";
import {
  DesktopProjectNotesReply,
  DesktopProjectNotesRequest,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDesktopProjectNotesTransport } from "./DesktopProjectNotesTransport.ts";

const environmentId = EnvironmentId.make("native");
const reply = Schema.encodeSync(Schema.fromJsonString(DesktopProjectNotesReply));
const decode = Schema.decodeSync(Schema.fromJsonString(DesktopProjectNotesRequest));
const list = {
  _tag: "list",
  input: { projectId: ProjectId.make("real"), archived: false, limit: 1 },
} as const;
const refused = { ok: false, failure: { reason: "unavailable" } } as const;
it.effect(
  "does not answer before ready, scopes its host and rejects a stale generation reply",
  () =>
    Effect.gen(function* () {
      const transport = yield* makeDesktopProjectNotesTransport("a".repeat(64));
      assert.deepEqual(yield* transport.call(environmentId, list), refused);
      yield* Stream.runHead(transport.outgoing);
      yield* transport.accept(reply({ _tag: "ready", version: 1, environmentId }));
      assert.deepEqual(yield* transport.call(EnvironmentId.make("remote"), list), refused);
      const pending = yield* transport.call(environmentId, list).pipe(Effect.forkScoped);
      const frame = yield* Stream.runHead(transport.outgoing);
      if (Option.isNone(frame)) return assert.fail("expected a frame");
      const sent = decode(new TextDecoder().decode(frame.value));
      if (sent._tag !== "call") return assert.fail("expected a request");
      yield* transport.accept(
        reply({
          _tag: "result",
          version: 1,
          requestId: "stale",
          result: { _tag: "list", value: { notes: [], nextCursor: null } },
        }),
      );
      assert.deepEqual(yield* Fiber.join(pending), refused);
      assert.isNull(yield* transport.status);
    }),
);

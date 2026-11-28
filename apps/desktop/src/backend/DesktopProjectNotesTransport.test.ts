import { assert, it } from "@effect/vitest";
import {
  DesktopProjectNotesReply,
  DesktopProjectNotesRequest,
  EnvironmentId,
  ProjectId,
  ProjectNoteId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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
      const revocations = yield* Ref.make(0);
      const transport = yield* makeDesktopProjectNotesTransport(
        "a".repeat(64),
        Ref.update(revocations, (count) => count + 1),
      );
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
      yield* transport.close;
      assert.equal(yield* Ref.get(revocations), 1);
    }),
);

it.effect("retries a timed-out write by mutation ID without accepting its late reply", () =>
  Effect.gen(function* () {
    const transport = yield* makeDesktopProjectNotesTransport("a".repeat(64));
    yield* Stream.runHead(transport.outgoing);
    yield* transport.accept(reply({ _tag: "ready", version: 1, environmentId }));
    const call = {
      _tag: "create",
      input: {
        projectId: ProjectId.make("real"),
        title: "note",
        markdown: "",
        mutationId: "same-write",
      },
    } as const;
    const nextCall = Effect.gen(function* () {
      const frame = yield* Stream.runHead(transport.outgoing);
      if (Option.isNone(frame)) throw new Error("expected a frame");
      const sent = decode(new TextDecoder().decode(frame.value));
      if (sent._tag !== "call") throw new Error("expected a request");
      return sent;
    });
    const first = yield* transport.call(environmentId, call).pipe(Effect.forkScoped);
    const firstSent = yield* nextCall;
    yield* TestClock.adjust("6 seconds");
    assert.deepEqual(yield* Fiber.join(first), refused);
    assert.equal(yield* transport.status, environmentId);

    const second = yield* transport.call(environmentId, call).pipe(Effect.forkScoped);
    const secondSent = yield* nextCall;
    assert.notEqual(secondSent.requestId, firstSent.requestId);
    assert.deepEqual(secondSent.call, firstSent.call);
    const result = {
      _tag: "create",
      value: { id: ProjectNoteId.make("note-id"), revision: 1 },
    } as const;
    yield* transport.accept(
      reply({ _tag: "result", version: 1, requestId: firstSent.requestId, result }),
    );
    assert.equal(yield* transport.status, environmentId);
    yield* transport.accept(
      reply({ _tag: "result", version: 1, requestId: secondSent.requestId, result }),
    );
    assert.deepEqual(yield* Fiber.join(second), { ok: true, result });
  }),
);

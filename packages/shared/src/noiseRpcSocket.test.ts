import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";
import { makeNoiseRpcSocket } from "./noiseRpcSocket.ts";

// The peer is transparent here so the tests can inspect authenticated framing separately from the cipher.
const peer = { write: (bytes: Uint8Array) => bytes, read: (bytes: Uint8Array) => bytes };

it.effect("keeps a slow RPC client alive between authenticated records", () =>
  Effect.gen(function* () {
    const partial = new Uint8Array(4 + 48 * 1024);
    new DataView(partial.buffer).setUint32(0, 48 * 1024 + 1);
    const records = yield* Queue.unbounded<Uint8Array>();
    const socket = makeNoiseRpcSocket(
      {
        pull: Effect.map(Queue.take(records), (record) => [record] as const),
        upgrade: Socket.SocketUpgradeError.unsupported,
      },
      {
        write: () => Effect.die("Unexpected wire write"),
        writeAll: () => Effect.die("Unexpected batch"),
      },
      peer,
      "client",
    );
    const reader = yield* socket.reader;
    yield* Queue.offer(records, partial);
    assert.deepEqual(yield* reader.pull, ['{"_tag":"Pong"}']);
    yield* Queue.offer(records, Uint8Array.of(3));
    const [message] = yield* reader.pull;
    assert.ok(message instanceof Uint8Array);
    assert.equal(message.length, 48 * 1024 + 1);
    assert.equal(message.at(-1), 3);
  }).pipe(Effect.scoped),
);

it.effect(
  "reassembles concurrent writes over the Noise record limit and preserves batched and empty frames",
  () =>
    Effect.gen(function* () {
      const wire = yield* Queue.unbounded<Uint8Array>();
      const underlying: Socket.Writer = {
        write: (frame) => {
          assert.ok(frame instanceof Uint8Array);
          assert.isAtMost(frame.length, 65_535 - 16);
          return Queue.offer(wire, frame).pipe(Effect.asVoid);
        },
        writeAll: () => Effect.die("Unexpected raw batch"),
      };
      const socket = makeNoiseRpcSocket(
        {
          pull: Queue.takeAll(wire),
          upgrade: Socket.SocketUpgradeError.unsupported,
        },
        underlying,
        peer,
      );
      const writer = yield* socket.writer;
      const a = "A😀".repeat(40_000);
      const b = "中文".repeat(18_000);
      yield* Effect.all([writer.writeAll([a, ""]), writer.write(b)], { concurrency: "unbounded" });
      const result = yield* (yield* socket.reader).pull;
      const messages = result.map((m) => new TextDecoder().decode(m as Uint8Array));
      assert.deepEqual(messages.toSorted(), ["", a, b].toSorted());
    }).pipe(Effect.scoped),
);

it.effect(
  "closes on oversized declared lengths or malformed continuation and refuses subsequent writes",
  () =>
    Effect.gen(function* () {
      const invalid = new Uint8Array([255, 255, 255, 255]);
      const partial = new Uint8Array(48 * 1024 + 4);
      new DataView(partial.buffer).setUint32(0, 48 * 1024 + 2);
      for (const batch of [[invalid], [partial, Uint8Array.of(1)], ["plaintext"]] as const) {
        let closes = 0;
        const socket = makeNoiseRpcSocket(
          { pull: Effect.succeed(batch), upgrade: Socket.SocketUpgradeError.unsupported },
          {
            write: (frame) =>
              Effect.sync(() => {
                assert.ok(Socket.isCloseEvent(frame));
                closes++;
              }),
            writeAll: () => Effect.die("Unexpected raw batch"),
          },
          peer,
        );
        assert.isTrue(yield* Effect.isFailure((yield* socket.reader).pull));
        assert.isTrue(yield* Effect.isFailure((yield* socket.writer).write("private")));
        assert.equal(closes, 1);
      }
    }).pipe(Effect.scoped),
);

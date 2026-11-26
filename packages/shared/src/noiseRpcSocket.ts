import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/socket/Socket";
import { PART_RECEIVED_FRAME } from "./socketFrameParts.ts";

const encoder = new TextEncoder();
const chunkSize = 48 * 1024;
const maxMessage = 16 * 1024 * 1024;
const header = 4;
const tag = 16;
// An unpausable WebSocket can queue one full message, its record tags and the handshake reply.
export const NOISE_RPC_HIGH_WATER_MARK = maxMessage + chunkSize;

interface NoiseTransport {
  read(record: Uint8Array): Uint8Array;
  write(plaintext: Uint8Array): Uint8Array;
}

// Only the first encrypted record carries the uint32 big-endian message size.
// Subsequent records carry exactly the remaining bytes, up to chunkSize per record.
export function makeNoiseRpcSocket(
  reader: Socket.Reader,
  writer: Socket.Writer,
  peer: NoiseTransport,
  receiver: "client" | "server" = "server",
): Socket.Socket {
  const writes = Semaphore.makeUnsafe(1);
  let closed = false;
  let pending: Uint8Array | undefined;
  let offset = 0;
  const abort = Effect.suspend(() => {
    if (closed) return Effect.void;
    closed = true;
    pending = undefined;
    return writer.write(new Socket.CloseEvent(1002)).pipe(Effect.ignore);
  });
  const writeError = () =>
    new Socket.SocketError({
      reason: new Socket.SocketWriteError({ cause: "Invalid Noise RPC write" }),
    });
  const readError = () =>
    new Socket.SocketError({
      reason: new Socket.SocketReadError({ cause: "Invalid Noise RPC record" }),
    });

  // One per serialized RPC frame, already covered by the caller’s span.
  const send = Effect.fnUntraced(function* (frame: Uint8Array | string) {
    if (closed || frame.length > maxMessage) return yield* writeError();
    const bytes = typeof frame === "string" ? encoder.encode(frame) : frame;
    if (bytes.length > maxMessage) return yield* writeError();
    let sent = 0;
    do {
      const start = sent;
      const length = Math.min(chunkSize, bytes.length - sent);
      const record = yield* Effect.try({
        try: () => {
          const data = bytes.subarray(start, start + length);
          if (start !== 0) return peer.write(data);
          const first = new Uint8Array(header + length);
          new DataView(first.buffer).setUint32(0, bytes.length);
          first.set(data, header);
          return peer.write(first);
        },
        catch: writeError,
      });
      yield* writer.write(record);
      sent += length;
    } while (sent < bytes.length);
  });

  const receive = (record: Uint8Array | string) => {
    if (closed || typeof record === "string" || record.length > chunkSize + header + tag)
      throw readError();
    const plain = peer.read(record);
    if (!pending) {
      if (plain.length < header) throw readError();
      const size = new DataView(plain.buffer, plain.byteOffset, header).getUint32(0);
      if (size > maxMessage || plain.length !== header + Math.min(size, chunkSize))
        throw readError();
      if (size <= chunkSize) return plain.subarray(header);
      pending = new Uint8Array(size);
      pending.set(plain.subarray(header));
      offset = chunkSize;
      return;
    }
    if (plain.length !== Math.min(pending.length - offset, chunkSize)) throw readError();
    pending.set(plain, offset);
    offset += plain.length;
    if (offset === pending.length) {
      const complete = pending;
      pending = undefined;
      return complete;
    }
  };
  const pull = Effect.gen(function* () {
    while (true) {
      const records = yield* reader.pull;
      const complete = yield* Effect.try({
        try: () =>
          records.flatMap((record) => {
            const message = receive(record);
            return message ? [message] : [];
          }),
        catch: readError,
      });
      if (Arr.isArrayNonEmpty(complete)) return complete;
      // An authenticated fragment counts toward the RPC client's ping deadline on slow links.
      if (receiver === "client") return [PART_RECEIVED_FRAME] as const;
    }
  }).pipe(Effect.onError(() => abort));

  // Serialize encryption with the actual write. Interrupting a partial message makes the connection unusable.
  const serialized = (effect: Effect.Effect<void, Socket.SocketError>) =>
    effect.pipe(
      Effect.onError(() => abort),
      writes.withPermits(1),
    );
  return Socket.make({
    reader: Effect.succeed({ pull, upgrade: Socket.SocketUpgradeError.unsupported }),
    writer: Effect.succeed({
      write: (chunk) =>
        Socket.isCloseEvent(chunk)
          ? serialized(
              Effect.suspend(() => {
                closed = true;
                return writer.write(new Socket.CloseEvent());
              }),
            )
          : serialized(send(chunk)),
      writeAll: (frames) => serialized(Effect.forEach(frames, send, { discard: true })),
    }),
  });
}

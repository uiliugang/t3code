import { peerRequestHeaders, peerResponseHeaders } from "../peer/noiseTrust.ts";
import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  type NoiseMediaControl,
  NOISE_MEDIA_MAX_MESSAGE_BYTES,
  decodeNoiseMediaFrame,
  encodeNoiseMediaControl,
  encodeNoiseMediaData,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Parse HTTP responses on an in-memory duplex without making a network connection.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Bind a Node HTTP agent to the existing session-owned duplex.
import type * as NodeStream from "node:stream";

type Request = Extract<NoiseMediaControl, { op: "http" | "ws" }>;
class BrowserMediaClosed extends Schema.TaggedError<
  BrowserMediaClosed,
  { readonly brand: unique symbol }
>()("BrowserMediaClosed", {}) {}
const closed = () => new BrowserMediaClosed();

export const serveBrowserNoiseMedia = Effect.fn("connectNoise.browserMedia")(
  function* (
    request: Request,
    stream: NodeStream.Duplex,
    reader: Socket.Reader,
    writer: Socket.Writer,
    peer: boolean,
  ) {
    // Both clients use this duplex exclusively. Its other end is the existing session-bound HTTP router.
    const agent = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const owned = new NodeHttp.Agent({ keepAlive: false, maxSockets: 1 });
        owned.createConnection = () => stream;
        return owned;
      }),
      (value) => Effect.sync(() => value.destroy()),
    );
    const send = (control: NoiseMediaControl) => writer.write(encodeNoiseMediaControl(control));
    const read = Effect.gen(function* () {
      const batch = yield* reader.pull;
      const messages = [];
      for (const value of batch) {
        const frame = typeof value === "string" ? null : decodeNoiseMediaFrame(value);
        if (!frame) return yield* closed();
        messages.push(frame);
      }
      return messages;
    });
    if (request.op === "ws") {
      const ws = yield* Socket.fromWebSocket(
        Effect.acquireRelease(
          Effect.sync(
            () =>
              new NodeWS.WebSocket("ws://noise.invalid" + request.path, {
                agent,
                perMessageDeflate: false,
                maxPayload: NOISE_MEDIA_MAX_MESSAGE_BYTES,
              }),
          ),
          (value) => Effect.sync(() => value.terminate()),
        ),
        { disableReconnects: true, highWaterMark: NOISE_MEDIA_MAX_MESSAGE_BYTES + 1 },
      );
      const fromHost = yield* ws.reader;
      const toHost = yield* ws.writer;
      yield* send({ op: "open" });
      const outgoing = Effect.forever(
        fromHost.pull.pipe(
          Effect.flatMap((frames) =>
            Effect.forEach(frames, (frame) => writer.write(encodeNoiseMediaData(frame)), {
              discard: true,
            }),
          ),
        ),
      );
      const incoming = Effect.gen(function* () {
        while (true) {
          for (const frame of yield* read) {
            if (frame.kind === "control") {
              if (frame.control.op !== "close") return yield* closed();
              return;
            }
            yield* toHost.write(frame.kind === "text" ? frame.text : frame.bytes);
          }
        }
      });
      yield* Effect.raceFirst(incoming, outgoing).pipe(
        Effect.catchReason("SocketError", "SocketCloseError", (reason) =>
          send({ op: "close", code: reason.code }),
        ),
      );
      return;
    }

    const headers = request.headers ?? {};
    if (
      Object.entries(headers).some(
        ([key, value]) =>
          ![
            "accept",
            "content-type",
            "content-length",
            "range",
            "if-range",
            ...(peer ? peerRequestHeaders : []),
          ].includes(key) || /[\r\n]/.test(value),
      )
    )
      return yield* closed();
    const length = headers["content-length"];
    if (
      length !== undefined &&
      (!/^\d+$/.test(length) ||
        !Number.isSafeInteger(Number(length)) ||
        (request.method !== "POST" && Number(length) !== 0))
    )
      return yield* closed();
    const responseReady = yield* Deferred.make<NodeHttp.IncomingMessage, BrowserMediaClosed>();
    const req = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const req = NodeHttp.request(
            { agent, host: "noise.invalid", path: request.path, method: request.method, headers },
            (value) => Deferred.doneUnsafe(responseReady, Effect.succeed(value)),
          );
          req.on("error", () => Deferred.doneUnsafe(responseReady, Effect.fail(closed())));
          return req;
        },
        catch: closed,
      }),
      (value) =>
        Effect.sync(() => {
          value.destroy();
        }),
    );
    if (request.method !== "POST") req.end();
    const upload = Effect.gen(function* () {
      let uploaded = 0;
      let ended = false;
      while (true) {
        for (const frame of yield* read) {
          if (ended) return yield* closed();
          if (frame.kind === "control" && frame.control.op === "end") {
            if (length !== undefined && uploaded !== Number(length)) return yield* closed();
            if (request.method === "POST") req.end();
            ended = true;
            continue;
          }
          if (
            request.method !== "POST" ||
            frame.kind !== "binary" ||
            frame.bytes.length > NOISE_MEDIA_MAX_MESSAGE_BYTES
          )
            return yield* closed();
          uploaded += frame.bytes.length;
          if (length !== undefined && uploaded > Number(length)) return yield* closed();
          yield* Effect.callback<void, BrowserMediaClosed>((resume) => {
            req.write(frame.bytes, (error) => resume(error ? Effect.fail(closed()) : Effect.void));
          });
        }
      }
    });
    const download = Effect.gen(function* () {
      const response = yield* Deferred.await(responseReady);
      const headers: Record<string, string> = {};
      for (const field of [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "content-disposition",
        "etag",
        "last-modified",
        "cache-control",
        "content-security-policy",
        ...(peer ? peerResponseHeaders : []),
      ]) {
        const value = response.headers[field];
        if (typeof value === "string") headers[field] = value;
      }
      yield* send({ op: "response", status: response.statusCode ?? 502, headers });
      yield* Stream.fromAsyncIterable<Buffer, BrowserMediaClosed>(response, closed).pipe(
        Stream.runForEach((bytes) =>
          Effect.gen(function* () {
            for (let offset = 0; offset < bytes.length; offset += 48 * 1024) {
              yield* writer.write(encodeNoiseMediaData(bytes.subarray(offset, offset + 48 * 1024)));
            }
          }),
        ),
      );
      if (!response.complete) return yield* closed();
      yield* send({ op: "end" });
    });
    yield* Effect.raceFirst(upload, download);
  },
  (effect, _request, _stream, _reader, writer, _peer) =>
    effect.pipe(
      Effect.tapError(() =>
        writer.write(encodeNoiseMediaControl({ op: "close", code: 1011 })).pipe(Effect.ignore),
      ),
    ),
);

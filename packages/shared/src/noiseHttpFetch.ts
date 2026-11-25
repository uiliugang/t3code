import {
  decodeNoiseMediaFrame,
  encodeNoiseMediaControl,
  encodeNoiseMediaData,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Socket from "effect/socket/Socket";

export type OpenNoiseHttp<E> = Effect.Effect<{ readonly socket: Socket.Socket }, E, Scope.Scope>;
class NoiseHttpReadError extends Schema.TaggedError<
  NoiseHttpReadError,
  { readonly brand: unique symbol }
>()("NoiseHttpReadError", {}) {}
const invalid = () => new NoiseHttpReadError({});
const fromStreamError = invalid;
const upload = Effect.fn("noiseHttp.upload")(function* (request: Request, writer: Socket.Writer) {
  if (request.method !== "POST") return;
  if (request.body) {
    const body = request.body.getReader();
    try {
      while (true) {
        const part = yield* Effect.tryPromise({ try: () => body.read(), catch: fromStreamError });
        if (part.done) break;
        for (let offset = 0; offset < part.value.length; offset += 48 * 1024) {
          yield* writer.write(
            encodeNoiseMediaData(part.value.subarray(offset, offset + 48 * 1024)),
          );
        }
      }
    } finally {
      void body.cancel().catch(() => {});
    }
  }
  yield* writer.write(encodeNoiseMediaControl({ op: "end" }));
});

export function fetchNoiseHttp<E>(
  open: OpenNoiseHttp<E>,
  lifetime: AbortSignal,
  request: Request,
  path: string,
  method: "GET" | "HEAD" | "POST",
  headers: Record<string, string>,
): Promise<Response> {
  const cancel = new AbortController();
  const signal = AbortSignal.any([lifetime, request.signal, cancel.signal]);
  const response = Promise.withResolvers<Response>();
  const body = new TransformStream<Uint8Array, Uint8Array>();
  const sink = body.writable.getWriter();
  void sink.closed.catch(() => cancel.abort());
  const exchange = Effect.gen(function* () {
    const { socket } = yield* open;
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    yield* writer.write(encodeNoiseMediaControl({ op: "http", method, path, headers }));
    const receive = Effect.gen(function* () {
      let started = false;
      let noBody = false;
      while (true) {
        for (const raw of yield* reader.pull) {
          const frame = typeof raw === "string" ? null : decodeNoiseMediaFrame(raw);
          if (!frame) throw invalid();
          if (!started && frame.kind === "control" && frame.control.op === "response") {
            const { status, headers } = frame.control;
            noBody = method === "HEAD" || [204, 205, 304].includes(status);
            response.resolve(new Response(noBody ? null : body.readable, { status, headers }));
            started = true;
          } else if (started && frame.kind === "control" && frame.control.op === "end") {
            yield* Effect.tryPromise({ try: () => sink.close(), catch: fromStreamError });
            return;
          } else if (started && !noBody && frame.kind === "binary") {
            yield* Effect.tryPromise({
              try: () => sink.write(frame.bytes),
              catch: fromStreamError,
            });
          } else throw invalid();
        }
      }
    });
    yield* Effect.raceFirst(upload(request, writer).pipe(Effect.andThen(Effect.never)), receive);
  });
  void Effect.runPromise(Effect.scoped(exchange), { signal }).catch((cause) => {
    response.reject(cause);
    void sink.abort(cause).catch(() => {});
  });
  return response.promise;
}

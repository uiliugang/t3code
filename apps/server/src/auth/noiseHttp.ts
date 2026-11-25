import * as NodeZlib from "node:zlib";
import * as NodeUtil from "node:util";
import {
  isNoiseHttpRoute,
  NOISE_HTTP_CHUNK_BYTES,
  NOISE_HTTP_MAX_REQUEST_BYTES,
  NOISE_HTTP_MAX_RESPONSE_BYTES,
  NOISE_HTTP_ORIGIN,
  NoiseHttpError,
  type NoiseHttpRequest,
  type NoiseHttpUpload,
  ORCHESTRATION_PROTOCOL_HEADER,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
  type HttpRouter,
} from "effect/http";
import type { AuthenticatedSession } from "./EnvironmentAuth.ts";
import { NOISE_SESSION_SUBJECT } from "./SessionStore.ts";

// Only Request objects constructed in this process can carry the socket's authenticated identity.
const sessions = new WeakMap<object, AuthenticatedSession>();
export function registerNoiseHttpSession(source: object, session: AuthenticatedSession) {
  sessions.set(source, session);
}
export function noiseHttpSession(request: HttpServerRequest.HttpServerRequest) {
  return typeof request.source === "object" && request.source !== null
    ? sessions.get(request.source)
    : undefined;
}
const compress = NodeUtil.promisify(NodeZlib.deflateRaw);
const invalid = () => new NoiseHttpError({ message: "Invalid encrypted HTTP request." });

export function makeNoiseHttpBridge(session: AuthenticatedSession, router?: HttpRouter.HttpRouter) {
  const uploads = new Map<number, { chunks: Uint8Array[]; size: number }>();
  let staged = 0;
  const remove = (id: number) => {
    const value = uploads.get(id);
    if (value) {
      staged -= value.size;
      uploads.delete(id);
    }
    return value;
  };
  const upload = Effect.fn("noiseHttp.stage")(function* (input: typeof NoiseHttpUpload.Type) {
    if (session.subject !== NOISE_SESSION_SUBJECT) return yield* invalid();
    if (!input.data) {
      remove(input.id);
      return;
    }
    const value = uploads.get(input.id) ?? { chunks: [], size: 0 };
    if (
      (!value.size && uploads.size >= 2) ||
      input.offset !== value.size ||
      input.data.length === 0 ||
      staged + input.data.length > NOISE_HTTP_MAX_REQUEST_BYTES
    ) {
      remove(input.id);
      return yield* invalid();
    }
    value.chunks.push(input.data);
    value.size += input.data.length;
    staged += input.data.length;
    uploads.set(input.id, value);
  });
  const dispatch = (input: typeof NoiseHttpRequest.Type) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const stagedBody = input.uploadId === undefined ? undefined : remove(input.uploadId);
        const url = URL.parse(input.path, NOISE_HTTP_ORIGIN);
        if (
          !router ||
          session.subject !== NOISE_SESSION_SUBJECT ||
          !url ||
          !input.path.startsWith("/") ||
          input.path !== url.pathname + url.search ||
          url.origin !== NOISE_HTTP_ORIGIN ||
          !isNoiseHttpRoute(input.method, url) ||
          (input.uploadId !== undefined && (!stagedBody || input.body))
        ) {
          return yield* invalid();
        }
        const body = stagedBody ? Buffer.concat(stagedBody.chunks, stagedBody.size) : input.body;
        const request = yield* Effect.try({
          try: () =>
            new Request(url, {
              method: input.method,
              headers: {
                ...(input.contentType ? { "content-type": input.contentType } : {}),
                ...(body ? { "content-length": String(body.length) } : {}),
                ...(input.protocol ? { [ORCHESTRATION_PROTOCOL_HEADER]: input.protocol } : {}),
              },
              ...(body ? { body: Buffer.from(body.buffer, body.byteOffset, body.length) } : {}),
            }),
          catch: invalid,
        });
        registerNoiseHttpSession(request, session);
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- The Effect router exposes untyped handler errors at its public boundary.
        const response = yield* router.asHttpEffect().pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : HttpServerError.causeResponse(cause).pipe(Effect.map(([response]) => response)),
          ),
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(request),
          ),
        );
        let size = 0;
        // Compress each diff block independently. Credentials, headers and request bytes never enter its dictionary.
        const compressDiff =
          input.deflate && response.status === 200 && url.pathname === "/api/pull-requests/diff";
        const chunks = HttpServerResponse.toClientResponse(response).stream.pipe(
          Stream.flatMap((bytes) => {
            size += bytes.length;
            if (size > NOISE_HTTP_MAX_RESPONSE_BYTES) return Stream.fail(invalid());
            function* parts() {
              for (let offset = 0; offset < bytes.length; offset += NOISE_HTTP_CHUNK_BYTES) {
                yield { data: bytes.subarray(offset, offset + NOISE_HTTP_CHUNK_BYTES) };
              }
            }
            return Stream.fromIterable(parts());
          }),
          Stream.mapEffect((part) => {
            if (!compressDiff || part.data.length < 4096) return Effect.succeed(part);
            return Effect.tryPromise({
              try: () => compress(part.data, { level: 1 }),
              catch: invalid,
            }).pipe(
              Effect.map((data) =>
                data.length + 32 < part.data.length
                  ? { data, originalSize: part.data.length }
                  : part,
              ),
            );
          }),
          Stream.rechunk(1),
          Stream.mapError(invalid),
        );
        return Stream.concat(
          Stream.succeed({
            status: response.status,
            contentType: response.headers["content-type"] ?? "",
          }),
          chunks,
        );
      }),
    );
  return { dispatch, upload };
}

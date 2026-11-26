import {
  type NoiseHttpPart,
  type NoiseHttpRequest,
  type NoiseHttpUpload,
  isNoiseHttpRoute,
  NOISE_HTTP_CHUNK_BYTES,
  NOISE_HTTP_MAX_REQUEST_BYTES,
  NOISE_HTTP_MAX_RESPONSE_BYTES,
  NOISE_HTTP_ORIGIN,
  ORCHESTRATION_PROTOCOL_HEADER,
  WS_METHODS,
} from "@t3tools/contracts";
import { inflateSync } from "fflate";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpServerResponse } from "effect/http";

export function makeNoiseHttpClient(rpc: {
  readonly [WS_METHODS.serverNoiseHttp]: (
    request: typeof NoiseHttpRequest.Type,
  ) => Stream.Stream<typeof NoiseHttpPart.Type, Error>;
  readonly [WS_METHODS.serverNoiseHttpUpload]: (
    upload: typeof NoiseHttpUpload.Type,
  ) => Effect.Effect<void, Error>;
}) {
  let uploadId = 0;
  return HttpClient.make((request, url) => {
    const transportError = () =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          description: "Encrypted environment request failed.",
        }),
      });
    return Effect.gen(function* () {
      const method = request.method;
      if (
        url.origin !== NOISE_HTTP_ORIGIN ||
        url.username ||
        url.password ||
        url.hash ||
        (method !== "GET" && method !== "POST" && method !== "DELETE") ||
        !isNoiseHttpRoute(method, url)
      )
        return yield* transportError();
      const body = request.body._tag === "Uint8Array" ? request.body.body : undefined;
      if (
        (!body && request.body._tag !== "Empty") ||
        (body && body.length > NOISE_HTTP_MAX_REQUEST_BYTES)
      )
        return yield* transportError();
      const id = body && body.length > NOISE_HTTP_CHUNK_BYTES ? ++uploadId : undefined;
      const run = Effect.gen(function* () {
        if (body && id !== undefined) {
          for (let offset = 0; offset < body.length; offset += NOISE_HTTP_CHUNK_BYTES) {
            yield* rpc[WS_METHODS.serverNoiseHttpUpload]({
              id,
              offset,
              data: body.subarray(offset, offset + NOISE_HTTP_CHUNK_BYTES),
            });
          }
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        let metadata: { status: number; contentType: string } | undefined;
        yield* rpc[WS_METHODS.serverNoiseHttp]({
          method,
          deflate: true,
          path: url.pathname + url.search,
          ...(request.headers["content-type"]
            ? { contentType: request.headers["content-type"] }
            : {}),
          ...(request.headers[ORCHESTRATION_PROTOCOL_HEADER]
            ? { protocol: request.headers[ORCHESTRATION_PROTOCOL_HEADER] }
            : {}),
          ...(id !== undefined ? { uploadId: id } : body ? { body } : {}),
        }).pipe(
          Stream.runForEach((part) =>
            Effect.suspend(() => {
              if ("status" in part) {
                if (metadata || part.status < 200 || part.status > 599) return transportError();
                metadata = part;
              } else {
                total += part.originalSize ?? part.data.length;
                if (!metadata || total > NOISE_HTTP_MAX_RESPONSE_BYTES) return transportError();
                if (part.originalSize === undefined) chunks.push(part.data);
                else {
                  if (url.pathname !== "/api/pull-requests/diff" || metadata.status !== 200)
                    return transportError();
                  const size = part.originalSize;
                  return Effect.try({
                    try: () => {
                      const bytes = inflateSync(part.data, { out: new Uint8Array(size + 1) });
                      if (bytes.length !== size) throw new RangeError();
                      chunks.push(bytes);
                    },
                    catch: transportError,
                  });
                }
              }
              return Effect.void;
            }),
          ),
        );
        if (!metadata) return yield* transportError();
        const bytes = chunks.length === 1 ? chunks[0]! : new Uint8Array(total);
        if (chunks.length > 1) {
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
        }
        return HttpServerResponse.toClientResponse(
          HttpServerResponse.uint8Array(bytes, {
            status: metadata.status,
            contentType: metadata.contentType,
          }),
          { request },
        );
      });
      return yield* id === undefined
        ? run
        : run.pipe(
            Effect.onError(() =>
              rpc[WS_METHODS.serverNoiseHttpUpload]({ id, offset: 0 }).pipe(
                Effect.ignore,
                Effect.timeoutOption("1 second"),
              ),
            ),
          );
    }).pipe(Effect.mapError(transportError));
  });
}

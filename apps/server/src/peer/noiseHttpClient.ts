import { NoisePeerRequest, NoisePeerReply } from "@t3tools/contracts";
import { openPinnedNoiseClient } from "../auth/pinnedNoiseClient.ts";
import { fetchNoiseHttp } from "@t3tools/shared/noiseHttpFetch";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { isPeerRoute, peerRequestHeaders, PeerTrust, type TrustedPeer } from "./noiseTrust.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(NoisePeerRequest));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(NoisePeerReply));
class PeerChannelError extends Schema.TaggedError<
  PeerChannelError,
  { readonly brand: unique symbol }
>()("PeerChannelError", {}) {}
const refused = () => new PeerChannelError({});
const open = Effect.fn("PeerLinks.openNoise")(function* (
  clientOrigin: string,
  target: TrustedPeer,
) {
  const { exchange, socket } = yield* openPinnedNoiseClient(
    target.origin,
    target.environmentId,
    target.pin,
  );
  const auth = yield* encode({
    mode: "peer",
    clientOrigin,
    targetOrigin: target.origin,
    token: target.token,
  });
  const reply = yield* decode(
    new TextDecoder().decode(yield* exchange(new TextEncoder().encode(auth))),
  );
  if (reply.status !== "peer-ready") return yield* refused();
  return { socket };
}, Effect.timeout("15 seconds"));

/** Redirects and failed pinned handshakes must never forward credentials to another transport. */
export const peerHttpClient = Effect.gen(function* () {
  const ordinary = yield* HttpClient.HttpClient;
  const trust = yield* PeerTrust;
  const direct = HttpClient.transform(ordinary, (response) =>
    Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
  );
  if (!trust) return direct;
  return HttpClient.make((req, url, signal) => {
    const target = trust.peers.find((peer) => peer.origin === url.origin);
    if (!target) return direct.execute(req);
    const path = url.pathname + url.search;
    const method = req.method;
    const failed = () =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request: req,
          description: "The pinned peer did not accept the encrypted request.",
        }),
      });
    if ((method !== "GET" && method !== "POST") || !isPeerRoute(method, path))
      return Effect.fail(failed());
    return Effect.gen(function* () {
      const request = yield* HttpClientRequest.toWeb(req, { signal });
      const headers: Record<string, string> = {};
      for (const key of ["accept", "content-type", ...peerRequestHeaders]) {
        const value = request.headers.get(key);
        if (value !== null) headers[key] = value;
      }
      const raw = yield* Effect.tryPromise({
        try: () =>
          fetchNoiseHttp(open(trust.origin, target), signal, request, path, method, headers),
        catch: failed,
      });
      return HttpClientResponse.fromWeb(req, raw);
    }).pipe(Effect.mapError(failed));
  });
});

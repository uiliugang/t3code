import {
  PEER_LINK_THREAD_STREAM_ROUTE,
  PEER_LINK_THREAD_HISTORY_ROUTE,
  PEER_LINK_THREAD_ITEM_ROUTE,
} from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HttpServerRequest } from "effect/http";

const origin = Schema.String.check(
  Schema.makeFilter((value) => {
    const url = URL.parse(value);
    return (
      !!url &&
      url.origin === value &&
      (url.protocol === "https:" || (url.protocol === "http:" && isLocalLoopbackHost(url.hostname)))
    );
  }),
);
const key = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{43}$/u));
const Peer = Schema.Struct({
  origin,
  environmentId: Schema.String.check(Schema.isNonEmpty()),
  pin: key,
  token: key,
});
export type TrustedPeer = typeof Peer.Type;
export const peerHostPin = (peer: TrustedPeer) =>
  "t3noise://pair#" + new URLSearchParams({ env: peer.environmentId, pin: peer.pin });
const Trust = Schema.Struct({ origin, peers: Schema.Array(Peer) }).check(
  Schema.makeFilter(
    (trust) =>
      new Set(trust.peers.map((p) => p.origin)).size === trust.peers.length &&
      new Set(trust.peers.map((p) => p.environmentId)).size === trust.peers.length &&
      new Set(trust.peers.map((p) => p.token)).size === trust.peers.length &&
      trust.peers.every((p) => p.origin !== trust.origin),
  ),
);
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Trust));
export class PeerTrust extends Context.Reference<typeof Trust.Type | null>("t3/peer/NoiseTrust", {
  defaultValue: () => null,
}) {}
class InvalidPeerTrust extends Schema.TaggedError<
  InvalidPeerTrust,
  { readonly brand: unique symbol }
>()("InvalidPeerTrust", {}) {
  override get message() {
    return "Could not read valid host trust settings from T3CODE_NOISE_PEERS_FILE.";
  }
}
export const layer = Layer.effect(
  PeerTrust,
  Effect.gen(function* () {
    const file = yield* Config.option(Config.String("T3CODE_NOISE_PEERS_FILE"));
    if (Option.isNone(file)) return null;
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file.value).pipe(
      Effect.flatMap(decode),
      Effect.mapError(() => new InvalidPeerTrust({})),
    );
  }),
);
export const NoisePeerCall = Context.Reference<boolean>("t3/peer/NoisePeerCall", {
  defaultValue: () => false,
});
export interface PeerPrincipal {
  readonly kind: "peer";
  readonly origin: string;
}
const sources = new WeakSet<object>();
export const registerPeerSource = (source: object) => sources.add(source);
export const isPeerRequest = (request: HttpServerRequest.HttpServerRequest) =>
  typeof request.source === "object" && request.source !== null && sources.has(request.source);
const reads = new Set<string>([
  PEER_LINK_THREAD_STREAM_ROUTE,
  PEER_LINK_THREAD_HISTORY_ROUTE,
  PEER_LINK_THREAD_ITEM_ROUTE,
]);
const posts = new Set([
  "/oauth/mcp/register",
  "/oauth/mcp/decision",
  "/oauth/mcp/token",
  "/oauth/mcp/revoke",
  "/mcp",
  "/api/peer-link/client-pairing",
]);
export function isPeerRoute(method: string, path: string) {
  const url = URL.parse(path, "https://peer.invalid");
  if (!url || url.origin !== "https://peer.invalid" || path !== url.pathname + url.search)
    return false;
  if (method === "GET") return reads.has(url.pathname) || path === "/.well-known/t3/environment";
  return method === "POST" && posts.has(path);
}
export const peerRequestHeaders = [
  "authorization",
  "mcp-session-id",
  "mcp-protocol-version",
  "t3-mode-limit",
  "t3-sender-thread",
];
export const peerResponseHeaders = ["mcp-session-id", "mcp-protocol-version", "t3-link-expires-at"];

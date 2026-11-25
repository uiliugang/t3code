import { CONNECT_NOISE_PATH } from "@t3tools/contracts";
import { initializeConnectNoise, makeNoiseInitiator } from "@t3tools/shared/connectNoiseWasm";
import { makeNoiseRpcSocket, NOISE_RPC_HIGH_WATER_MARK } from "@t3tools/shared/noiseRpcSocket";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

class PinnedNoiseChannelError extends Schema.TaggedError<
  PinnedNoiseChannelError,
  { readonly brand: unique symbol }
>()("PinnedNoiseChannelError", {}) {}
const refused = () => new PinnedNoiseChannelError({});
export const openPinnedNoiseClient = Effect.fn("connectNoise.openPinnedClient")(function* (
  origin: string,
  environment: string,
  pin: string,
) {
  yield* Effect.tryPromise({ try: initializeConnectNoise, catch: refused });
  const peer = yield* Effect.acquireRelease(
    Effect.try({
      try: () => makeNoiseInitiator(environment, Buffer.from(pin, "base64url")),
      catch: refused,
    }),
    (p) => Effect.sync(() => p.release()),
  );
  const endpoint = new URL(CONNECT_NOISE_PATH, origin);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  const ws = yield* Socket.makeWebSocket(endpoint.href, {
    highWaterMark: NOISE_RPC_HIGH_WATER_MARK,
    openTimeout: "8 seconds",
  });
  const reader = yield* ws.reader;
  const writer = yield* ws.writer;
  const exchange = Effect.fn("connectNoise.pinnedExchange")(function* (value: Uint8Array) {
    yield* writer.write(yield* Effect.try({ try: () => peer.write(value), catch: refused }));
    const batch = yield* reader.pull;
    const raw = batch[0];
    if (typeof raw === "string" || batch.length !== 1 || raw.length > 12288)
      return yield* refused();
    return yield* Effect.try({ try: () => peer.read(raw), catch: refused });
  });
  if ((yield* exchange(new Uint8Array())).length !== 32) return yield* refused();
  return { exchange, socket: makeNoiseRpcSocket(reader, writer, peer) };
}, Effect.provide(Socket.layerWebSocketConstructorGlobal));

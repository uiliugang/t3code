import {
  NoiseGuestRequest,
  NoiseGuestReply,
  ConnectNoiseRequest,
  ConnectNoiseResult,
  connectNoiseProofUrl,
} from "@t3tools/contracts";
import { makeNoiseRpcSocket } from "@t3tools/shared/noiseRpcSocket";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { assert } from "@effect/vitest";
import { NoisePeer } from "@t3tools/shared/connectNoiseWasm";
import type { makeDpopKey } from "./dpop.testkit.ts";

const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(ConnectNoiseRequest));
const decodeReply = Schema.decodeEffect(Schema.fromJsonString(ConnectNoiseResult));
const openPinnedChannel = Effect.fn("test.openPinnedChannel")(function* (url: string, pin: URL) {
  const params = new URLSearchParams(pin.hash.slice(1));
  const environment = params.get("env")!;
  const peer = yield* Effect.acquireRelease(
    Effect.sync(() => NoisePeer.client(environment, Buffer.from(params.get("pin")!, "base64url"))),
    (peer) => Effect.sync(() => peer.free()),
  );
  const ws = new WebSocket(url);
  const socket = yield* Socket.fromWebSocket(Effect.succeed(ws));
  const reader = yield* socket.reader;
  const writer = yield* socket.writer;
  yield* writer.write(peer.write(new Uint8Array()));
  const [hello] = yield* reader.pull;
  assert.ok(typeof hello !== "string");
  assert.equal(ws.extensions, "");
  const nonce = Buffer.from(peer.read(hello)).toString("base64url");
  return { environment, peer, ws, reader, writer, nonce };
});
const encodeGuest = Schema.encodeEffect(Schema.fromJsonString(NoiseGuestRequest));
const decodeGuest = Schema.decodeEffect(Schema.fromJsonString(NoiseGuestReply));
export const connectGuestNoiseClient = Effect.fn("test.connectGuestNoiseClient")(function* (
  url: string,
  pin: URL,
  request: NoiseGuestRequest,
) {
  const { peer, reader, writer } = yield* openPinnedChannel(url, pin);
  yield* writer.write(peer.write(Buffer.from(yield* encodeGuest(request))));
  const [reply] = yield* reader.pull;
  assert.ok(typeof reply !== "string");
  return {
    reply: yield* decodeGuest(Buffer.from(peer.read(reply)).toString()),
    socket: makeNoiseRpcSocket(reader, writer, peer),
  };
});
export const connectNoiseClient = Effect.fn("test.connectNoiseClient")(function* (
  url: string,
  pin: URL,
  device: ReturnType<typeof makeDpopKey>,
  credential: string,
  options: {
    wrongNonce?: boolean;
    mode?: "rpc" | "media";
    orchestrationProtocolVersion?: number;
  } = {},
) {
  const { environment, peer, ws, reader, writer, nonce } = yield* openPinnedChannel(url, pin);
  const proof = device.sign({
    method: "POST",
    url: connectNoiseProofUrl(environment),
    token: credential,
    iat: Math.floor((yield* Clock.currentTimeMillis) / 1000),
    nonce: options.wrongNonce ? "stale" : nonce,
  });
  const payload = yield* encodeRequest({
    credential,
    proof,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.orchestrationProtocolVersion === undefined
      ? {}
      : { orchestrationProtocolVersion: options.orchestrationProtocolVersion }),
  });
  yield* writer.write(peer.write(Buffer.from(payload)));
  const [reply] = yield* reader.pull;
  assert.ok(typeof reply !== "string");
  return {
    reply: yield* decodeReply(Buffer.from(peer.read(reply)).toString()),
    socket: makeNoiseRpcSocket(reader, writer, peer),
    ws,
  };
});

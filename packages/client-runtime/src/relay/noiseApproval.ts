import {
  CONNECT_NOISE_PATH,
  ConnectNoiseRequest,
  ConnectNoiseResult,
  readNoisePin,
  ORCHESTRATION_PROTOCOL_VERSION,
  connectDeviceVerificationCode,
  connectNoiseProofUrl,
} from "@t3tools/contracts";
import { makeNoiseRpcSocket, NOISE_RPC_HIGH_WATER_MARK } from "@t3tools/shared/noiseRpcSocket";
import * as Arr from "effect/Array";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { parseUrl } from "@t3tools/shared/url";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { ManagedRelayDpopSigner } from "./managedRelay.ts";

export class NoiseApprovalError extends Schema.TaggedError<
  NoiseApprovalError,
  { readonly brand: unique symbol }
>()("NoiseApprovalError", {
  message: Schema.String,
}) {}
const nativeOperation = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: () => new NoiseApprovalError({ message: "Noise record rejected" }),
  });

export interface NoiseApprovalPeer {
  write(bytes: Uint8Array): Uint8Array;
  read(bytes: Uint8Array): Uint8Array;
  release(): void;
}

export { readNoisePin };

const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(ConnectNoiseRequest));
const decodeReply = Schema.decodeEffect(Schema.fromJsonString(ConnectNoiseResult));
const maxReplyBytes = 2048;

interface HandshakeInput {
  pin: NonNullable<ReturnType<typeof readNoisePin>>;
  wsBaseUrl: string;
  credential: string;
  createPeer: (environment: string, key: Uint8Array) => NoiseApprovalPeer;
}

const handshake = Effect.fn("connectNoise.handshake")(function* (
  input: HandshakeInput,
  mode: "approval" | "rpc" | "media",
) {
  const rpc = mode !== "approval";
  const endpoint = parseUrl(input.wsBaseUrl);
  if (
    endpoint?.protocol !== "wss:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  )
    return yield* new NoiseApprovalError({ message: "Invalid secure relay endpoint" });
  endpoint.pathname = CONNECT_NOISE_PATH;
  const peer = yield* Effect.acquireRelease(
    nativeOperation(() => input.createPeer(input.pin.environmentId, input.pin.key)),
    (p) => Effect.sync(() => p.release()),
  );
  const socket = yield* Socket.makeWebSocket(endpoint.href, {
    openTimeout: "8 seconds",
    highWaterMark: rpc ? NOISE_RPC_HIGH_WATER_MARK : maxReplyBytes,
  });
  const reader = yield* socket.reader;
  const writer = yield* socket.writer;
  let buffered: ReadonlyArray<string | Uint8Array> = [];
  const exchange = Effect.fn("connectNoise.exchange")(function* (
    bytes: Uint8Array,
    allowMore: boolean,
  ) {
    yield* writer.write(yield* nativeOperation(() => peer.write(bytes)));
    const [record, ...extra] = yield* reader.pull;
    if ((!allowMore && extra.length) || typeof record === "string" || record.length > maxReplyBytes)
      return yield* new NoiseApprovalError({ message: "Invalid approval frame" });
    buffered = extra;
    return yield* nativeOperation(() => peer.read(record));
  });
  const challenge = yield* exchange(new Uint8Array(), false);
  if (challenge.length !== 32)
    return yield* new NoiseApprovalError({ message: "Invalid approval challenge" });
  const signer = yield* ManagedRelayDpopSigner;
  const proof = yield* signer.createProof({
    method: "POST",
    url: connectNoiseProofUrl(input.pin.environmentId),
    nonce: Base64Url.encode(challenge),
    accessToken: input.credential,
  });
  const encoded = yield* encodeRequest({
    credential: input.credential,
    proof,
    ...(rpc ? { mode, orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION } : {}),
  }).pipe(Effect.mapError(() => new NoiseApprovalError({ message: "Invalid approval request" })));
  const reply = yield* exchange(new TextEncoder().encode(encoded), rpc);
  const result = yield* decodeReply(new TextDecoder().decode(reply)).pipe(
    Effect.mapError(() => new NoiseApprovalError({ message: "Invalid approval response" })),
  );
  if (
    result.status === "pending" &&
    result.verificationCode !== connectDeviceVerificationCode(yield* signer.thumbprint)
  )
    return yield* new NoiseApprovalError({ message: "Device verification code mismatch" });
  if (result.status !== "connected") {
    if (buffered.length || (rpc && result.status === "approved"))
      return yield* new NoiseApprovalError({ message: "Host does not support encrypted RPC" });
    return result;
  }
  if (!rpc || result.orchestrationProtocolVersion !== ORCHESTRATION_PROTOCOL_VERSION)
    return yield* new NoiseApprovalError({ message: "Incompatible encrypted RPC protocol" });

  const rpcReader = {
    upgrade: reader.upgrade,
    pull: Effect.suspend(() => {
      if (!Arr.isReadonlyArrayNonEmpty(buffered)) return reader.pull;
      const batch = buffered;
      buffered = [];
      return Effect.succeed(batch);
    }),
  };
  return {
    ...result,
    socket: makeNoiseRpcSocket(rpcReader, writer, peer, mode === "media" ? "server" : "client"),
  };
}, Effect.timeout("15 seconds"));

export const verifyNoiseApproval = Effect.fn("connectNoise.verifyApproval")(function* (
  input: HandshakeInput,
) {
  const result = yield* handshake(input, "approval");
  if (result.status === "connected")
    return yield* new NoiseApprovalError({ message: "Unexpected encrypted RPC session" });
  return result;
}, Effect.scoped);

export const openNoiseRpc = Effect.fn("connectNoise.openRpc")(function* (
  input: HandshakeInput,
  mode: "rpc" | "media" = "rpc",
) {
  const scope = yield* Scope.fork(yield* Effect.scope);
  const result = yield* handshake(input, mode).pipe(
    Scope.provide(scope),
    Effect.onExit((exit) =>
      Exit.isSuccess(exit) && exit.value.status === "connected"
        ? Effect.void
        : Scope.close(scope, exit),
    ),
  );
  if (result.status === "approved")
    return yield* new NoiseApprovalError({ message: "Host does not support encrypted RPC" });
  return result;
});

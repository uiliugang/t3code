import {
  AuthAccessWriteScope,
  LocalDeviceNoiseRequest,
  LocalDeviceNoiseReply,
} from "@t3tools/contracts";
import { SessionStore, LOCAL_NOISE_DEVICE_SUBJECT } from "./SessionStore.ts";
import { PeerTrust, type PeerPrincipal } from "../peer/noiseTrust.ts";
import { timingSafeEqual } from "effect/crypto/Mac";
import {
  NoiseGuestRequest,
  NoiseGuestReply,
  NoisePeerRequest,
  NoisePeerReply,
} from "@t3tools/contracts";
import { GuestShareService } from "../guest/GuestShareService.ts";
import { NoiseGuestCall, type NoiseGuestSession } from "./noiseGuestContext.ts";
import { noiseHostIdentity, noiseHostKeyName } from "./noiseHostIdentity.ts";
import {
  CONNECT_NOISE_PATH,
  ORCHESTRATION_PROTOCOL_VERSION,
  ConnectNoiseRequest,
  connectDeviceVerificationCode,
  connectNoiseProofUrl,
  ConnectNoiseResult,
} from "@t3tools/contracts";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { makeNoiseRpcSocket } from "@t3tools/shared/noiseRpcSocket";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { PairingGrantStore, type BootstrapCredentialInternalError } from "./PairingGrantStore.ts";
import { ServerSecretStore } from "./ServerSecretStore.ts";
import { initializeConnectNoise, NoisePeer } from "@t3tools/shared/connectNoiseWasm";

const decodeLocalDevice = Schema.decodeOption(Schema.fromJsonString(LocalDeviceNoiseRequest));
const encodeLocalDevice = Schema.encodeEffect(Schema.fromJsonString(LocalDeviceNoiseReply));
const decideLocalDevice = Effect.fn("connectNoise.decideLocalDevice")(
  function* (input: LocalDeviceNoiseRequest) {
    const session = yield* (yield* SessionStore).verify(input.token);
    if (
      session.method !== "bearer-access-token" ||
      session.subject !== LOCAL_NOISE_DEVICE_SUBJECT ||
      !session.scopes.includes(AuthAccessWriteScope)
    )
      return { status: "rejected" } as const;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const changed = yield* input.action === "approve"
      ? auth.approveConnectDevice(input.target, session.subject)
      : input.action === "deny"
        ? auth.revokePairingLink(input.target)
        : auth.revokeConnectDevice(input.target);
    return { status: "decided", changed } as const;
  },
  Effect.orElseSucceed(() => ({ status: "rejected" }) as const),
);
const decodePeer = Schema.decodeOption(Schema.fromJsonString(NoisePeerRequest));
const encodePeerReply = Schema.encodeEffect(Schema.fromJsonString(NoisePeerReply));
const encodeUtf8 = new TextEncoder();
const encodeGuestReply = Schema.encodeEffect(Schema.fromJsonString(NoiseGuestReply));
const decodeGuest = Schema.decodeOption(Schema.fromJsonString(NoiseGuestRequest));
const init = Effect.promise(initializeConnectNoise);
const encodeReply = Schema.encodeEffect(Schema.fromJsonString(ConnectNoiseResult));
const decode = Schema.decodeOption(Schema.fromJsonString(ConnectNoiseRequest));

export const createNoisePin = Effect.fn("connectNoise.createPin")(function* () {
  const policy = yield* ManagedPolicy.ManagedPolicy;
  if (!ManagedLimits.allowsConnect(policy)) return yield* ManagedLimits.refuseConnect(policy);
  const params = new URLSearchParams(yield* noiseHostIdentity);
  return `t3noise://pair#${params}`;
});

const authenticate = Effect.fn("connectNoise.authenticate")(function* (
  payload: Uint8Array,
  environment: string,
  nonce: string,
): Effect.fn.Return<
  { reply: ConnectNoiseResult; session?: EnvironmentAuth.AuthenticatedSession; media?: boolean },
  BootstrapCredentialInternalError | EnvironmentAuth.ServerAuthInternalError,
  PairingGrantStore | EnvironmentAuth.EnvironmentAuth | Scope.Scope
> {
  const request = decode(Buffer.from(payload).toString("utf8"));
  const rejected = { reply: { status: "rejected" } } as const;
  if (Option.isNone(request)) return rejected;
  const { credential, proof, mode, orchestrationProtocolVersion } = request.value;
  if (mode !== undefined && orchestrationProtocolVersion !== ORCHESTRATION_PROTOCOL_VERSION)
    return rejected;
  const verified = verifyDpopProof({
    proof,
    method: "POST",
    url: connectNoiseProofUrl(environment),
    expectedNonce: nonce,
    expectedAccessToken: credential,
    nowEpochSeconds: Math.floor((yield* Clock.currentTimeMillis) / 1000),
  });
  if (!verified.ok) return rejected;
  const pending = {
    reply: {
      status: "pending",
      verificationCode: connectDeviceVerificationCode(verified.thumbprint),
    },
  } as const;
  if (mode !== undefined) {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.openNoiseSession(credential, verified.thumbprint);
    if (session === "rejected") return rejected;
    if (session === "pending") return pending;
    return {
      reply: {
        status: "connected",
        scopes: session.scopes,
        expiresAt: session.expiresAt,
        auth: yield* auth.getDescriptor(),
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
      },
      session,
      media: mode === "media",
    };
  }
  const grant = yield* (yield* PairingGrantStore).exchangeNoise(credential, verified.thumbprint);
  return grant === "pending"
    ? pending
    : grant === "rejected"
      ? rejected
      : { reply: { status: "approved" } };
});

export const routeLayer = <R>(
  serve: (
    request: HttpServerRequest.HttpServerRequest,
    session: EnvironmentAuth.AuthenticatedSession,
    socket: Socket.Socket,
    media: boolean,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
  serveGuest?: (
    request: HttpServerRequest.HttpServerRequest,
    session: NoiseGuestSession,
    socket: Socket.Socket,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
  servePeer?: (
    request: HttpServerRequest.HttpServerRequest,
    principal: PeerPrincipal,
    socket: Socket.Socket,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const enabled = ManagedLimits.allowsConnect(yield* ManagedPolicy.ManagedPolicy);
      const slots = yield* Semaphore.make(32);
      const loadOnce = yield* Effect.cached(init);
      return HttpRouter.add(
        "GET",
        CONNECT_NOISE_PATH,
        Effect.gen(function* () {
          if (!enabled) return HttpServerResponse.empty({ status: 404 });
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.headers.upgrade?.toLowerCase() !== "websocket" || request.url.includes("?"))
            return HttpServerResponse.empty({ status: 400 });
          const result = yield* Effect.gen(function* () {
            const key = yield* (yield* ServerSecretStore).get(noiseHostKeyName);
            if (Option.isNone(key)) return HttpServerResponse.empty({ status: 404 });
            const environment = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
            yield* loadOnce;
            delete NodeHttpServerRequest.toIncomingMessage(request).headers[
              "sec-websocket-extensions"
            ];
            const socket = yield* request.upgrade;
            const reader = yield* socket.reader;
            const writer = yield* socket.writer;
            yield* Effect.addFinalizer(() =>
              writer.write(new Socket.CloseEvent()).pipe(Effect.ignore),
            );
            const peer = yield* Effect.acquireRelease(
              Effect.sync(() => NoisePeer.server(environment, key.value)),
              (peer) => Effect.sync(() => peer.free()),
            );
            const [hello, ...extra] = yield* reader.pull;
            if (extra.length || typeof hello === "string" || hello.length !== 48)
              return HttpServerResponse.empty();
            peer.read(hello);
            const nonce = yield* (yield* SecureRandom.SecureRandom).randomBytes(32);
            yield* writer.write(peer.write(nonce));
            const [record, ...trailing] = yield* reader.pull;
            if (trailing.length || typeof record === "string" || record.length > 12_288)
              return HttpServerResponse.empty();
            const payload = peer.read(record);
            const text = Buffer.from(payload).toString("utf8");
            const decision = decodeLocalDevice(text);
            if (Option.isSome(decision)) {
              const reply = yield* decideLocalDevice(decision.value);
              yield* writer.write(peer.write(Buffer.from(yield* encodeLocalDevice(reply))));
              return HttpServerResponse.empty();
            }
            const host = decodePeer(text);
            if (Option.isSome(host)) {
              const trust = yield* PeerTrust;
              const input = host.value;
              const record = trust?.peers.find((entry) => entry.origin === input.clientOrigin);
              const accepted =
                servePeer &&
                trust &&
                input.targetOrigin === trust.origin &&
                record &&
                timingSafeEqual(encodeUtf8.encode(record.token), encodeUtf8.encode(input.token));
              yield* writer.write(
                peer.write(
                  Buffer.from(
                    yield* encodePeerReply({ status: accepted ? "peer-ready" : "rejected" }),
                  ),
                ),
              );
              if (!accepted) return HttpServerResponse.empty();
              return {
                host: { kind: "peer", origin: trust.origin } satisfies PeerPrincipal,
                socket: makeNoiseRpcSocket(reader, writer, peer),
              };
            }
            const guest = decodeGuest(text);
            if (Option.isSome(guest)) {
              const sessionAuth = yield* Effect.serviceOption(GuestShareService);
              const input = guest.value;
              const rejected = { status: "rejected" } as const;
              const result = yield* Effect.gen(function* () {
                if (!serveGuest || Option.isNone(sessionAuth)) return rejected;
                if (input.mode === "guest-redeem") {
                  const result = yield* sessionAuth.value.redeem(input);
                  return { status: "guest-redeemed", ...result } as const;
                }
                yield* sessionAuth.value.check(input.token, input.shareId);
                return { status: "guest-ready" } as const;
              }).pipe(
                Effect.provideService(NoiseGuestCall, true),
                Effect.orElseSucceed(() => rejected),
              );
              yield* writer.write(peer.write(Buffer.from(yield* encodeGuestReply(result))));
              if (result.status !== "guest-ready" || input.mode !== "guest-session")
                return HttpServerResponse.empty();
              return {
                guest: {
                  kind: "guest",
                  token: input.token,
                  shareId: input.shareId,
                } satisfies NoiseGuestSession,
                socket: makeNoiseRpcSocket(reader, writer, peer),
              };
            }
            const { reply, session, media } = yield* authenticate(
              payload,
              environment,
              Base64Url.encode(nonce),
            );
            yield* writer.write(peer.write(Buffer.from(yield* encodeReply(reply))));
            if (session === undefined) return HttpServerResponse.empty();
            return {
              session,
              media: media === true,
              socket: makeNoiseRpcSocket(reader, writer, peer),
            };
          }).pipe(
            Effect.timeout("15 seconds"),
            Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty())),
            slots.withPermitsIfAvailable(1),
          );
          if (Option.isNone(result)) return HttpServerResponse.empty({ status: 503 });
          if (HttpServerResponse.isHttpServerResponse(result.value)) return result.value;
          if ("host" in result.value && result.value.host)
            return yield* servePeer!(request, result.value.host, result.value.socket);
          if ("guest" in result.value && result.value.guest)
            return yield* serveGuest!(request, result.value.guest, result.value.socket);
          return yield* serve(
            request,
            result.value.session,
            result.value.socket,
            result.value.media,
          );
        }).pipe(Effect.scoped),
      );
    }),
  );

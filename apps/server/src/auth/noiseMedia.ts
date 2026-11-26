import { NoiseGuestCall, registerNoiseGuest, type NoiseGuestSession } from "./noiseGuestContext.ts";
import { GuestShareService } from "../guest/GuestShareService.ts";
import { isNoiseGuestRoute } from "@t3tools/contracts";
import { decodeNoiseMediaFrame } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Headers from "effect/http/Headers";
import { serveBrowserNoiseMedia } from "./browserNoiseMedia.ts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import type * as Socket from "effect/socket/Socket";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Feed encrypted HTTP/1.1 traffic to the same Node parser as a network connection.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The Node parser requires a duplex byte stream.
import * as NodeStream from "node:stream";
import { EnvironmentAuth, type AuthenticatedSession } from "./EnvironmentAuth.ts";
import type { AuthSessionId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import {
  isPeerRoute,
  NoisePeerCall,
  registerPeerSource,
  peerRequestHeaders,
  type PeerPrincipal,
} from "../peer/noiseTrust.ts";
import { registerNoiseHttpSession } from "./noiseHttp.ts";
import * as SessionStore from "./SessionStore.ts";

const deviceHub = "/api/device-hub/";
class MediaConnectionClosed extends Schema.TaggedError<
  MediaConnectionClosed,
  { readonly brand: unique symbol }
>()("MediaConnectionClosed", {}) {}

function isNoiseMediaRoute(method: string, path: string, upgrade: boolean) {
  const url = URL.parse(path, "http://media.invalid");
  if (
    !url ||
    url.origin !== "http://media.invalid" ||
    path !== url.pathname + url.search ||
    /[%](?:2f|5c|2e|25)/i.test(url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1)) ||
    url.searchParams.has("wsTicket")
  )
    return false;
  if (url.pathname.startsWith(deviceHub)) {
    // DeviceHubProxy owns the vendor path/method allowlist and the read/control scope split.
    return upgrade ? method === "GET" : ["GET", "HEAD", "POST"].includes(method);
  }
  if (upgrade)
    return (
      method === "GET" &&
      (url.pathname === "/api/preview/tunnel" || url.pathname === "/api/preview-stream/ws")
    );
  if (method === "POST") return url.pathname === "/api/preview-stream/upload";
  return (
    (method === "GET" || method === "HEAD") &&
    (url.pathname === "/api/preview-stream/download" ||
      /^\/api\/assets\/[\w.-]+(?:\/[^/]+)+$/.test(url.pathname))
  );
}

export const serveNoiseMedia = Effect.fn("connectNoise.serveMedia")(
  function* (
    outer: HttpServerRequest.HttpServerRequest,
    session: AuthenticatedSession | NoiseGuestSession | PeerPrincipal,
    encrypted: Socket.Socket,
    router: HttpRouter.HttpRouter,
  ) {
    const scope = yield* Effect.scope;
    const guest = "kind" in session && session.kind === "guest" ? session : null;
    const host = "kind" in session && session.kind === "peer" ? session : null;
    const linkedSession = yield* Deferred.make<AuthSessionId>();
    const allowed = (method: string, path: string, upgrade: boolean) =>
      guest
        ? !upgrade && isNoiseGuestRoute(method, path, guest.shareId)
        : host
          ? !upgrade && isPeerRoute(method, path)
          : isNoiseMediaRoute(method, path, upgrade);
    const untilRevoked =
      "kind" in session
        ? session.kind === "peer"
          ? Effect.flatMap(Deferred.await(linkedSession), (id) =>
              Effect.flatMap(SessionStore.SessionStore, (store) => store.awaitInvalidation(id)),
            )
          : (yield* GuestShareService)
              .untilRevoked(session.token)
              .pipe(Effect.provideService(NoiseGuestCall, true))
        : (yield* SessionStore.SessionStore).awaitInvalidation(
            session.sessionId,
            session.proofKeyThumbprint,
          );
    const servedPort = NodeHttpServerRequest.toIncomingMessage(outer).socket.localPort;
    const [stream, parser] = NodeStream.duplexPair();
    // Node's HTTP and WS parsers only use these TCP setters for optional tuning.
    for (const endpoint of [parser, stream]) {
      Object.assign(endpoint, {
        localPort: servedPort,
        setTimeout: () => endpoint,
        setNoDelay: () => endpoint,
        setKeepAlive: () => endpoint,
        destroySoon: () => endpoint.end(),
      });
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stream.destroy();
        parser.destroy();
      }),
    );
    const reader = yield* encrypted.reader;
    const writer = yield* encrypted.writer;
    let accepted = false;
    const dispatch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const source = NodeHttpServerRequest.toIncomingMessage(request);
      const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";
      if (accepted || !allowed(request.method, request.url, upgrade))
        return HttpServerResponse.empty({ status: 403 });
      accepted = true;
      // Peer links carry their MCP bearer here. Device and guest identity comes from the handshake.
      for (const name of Object.keys(source.headers)) {
        if (
          ![
            "host",
            "connection",
            "upgrade",
            "sec-websocket-key",
            "sec-websocket-version",
            "content-type",
            "content-length",
            "transfer-encoding",
            "range",
            "if-range",
            "accept",
            ...(host ? peerRequestHeaders : []),
          ].includes(name)
        )
          delete source.headers[name];
      }
      source.headers.host = host ? new URL(host.origin).host : "localhost";
      const inner = request.modify({
        headers: Headers.fromInput(source.headers),
        protocol: host?.origin.startsWith("https:") ? "https" : "http",
      });
      if (host) {
        if (request.url === "/mcp" || request.url.startsWith("/api/")) {
          const auth = yield* Effect.serviceOption(EnvironmentAuth);
          if (Option.isNone(auth)) return HttpServerResponse.empty({ status: 403 });
          const caller = yield* auth.value.authenticateMcpClient(inner).pipe(Effect.option);
          if (Option.isNone(caller) || !caller.value.peerLink)
            return HttpServerResponse.empty({ status: 401 });
          yield* Deferred.succeed(linkedSession, caller.value.sessionId);
        }
        registerPeerSource(source);
      } else if ("kind" in session) {
        if (session.kind !== "guest") return HttpServerResponse.empty({ status: 403 });
        registerNoiseGuest(source, session);
      } else registerNoiseHttpSession(source, session);
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- HttpRouter combines distinct route errors, mapped to their HTTP response below.
      return yield* router.asHttpEffect().pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, inner),
        Effect.provideService(NoiseGuestCall, guest !== null),
        Effect.provideService(NoisePeerCall, host !== null),
        Effect.catch((error) =>
          HttpServerRespondable.toResponseOrElse(error, HttpServerResponse.empty({ status: 500 })),
        ),
      );
    });
    const server = NodeHttp.createServer(
      { keepAliveTimeout: 0, maxHeaderSize: 16_384 },
      yield* NodeHttpServer.makeHandler(dispatch, { scope }),
    );
    server.maxRequestsPerSocket = 1;
    const wss = new NodeWS.WebSocketServer({ noServer: true, perMessageDeflate: false });
    yield* Effect.addFinalizer(() => Effect.sync(() => wss.close()));
    server.on(
      "upgrade",
      yield* NodeHttpServer.makeUpgradeHandler(Effect.succeed(wss), dispatch, { scope }),
    );
    server.emit("connection", parser);
    let buffered: ReadonlyArray<string | Uint8Array> = [];
    const pull = Effect.suspend(() => {
      if (!Arr.isReadonlyArrayNonEmpty(buffered)) return reader.pull;
      const batch = buffered;
      buffered = [];
      return Effect.succeed(batch);
    });
    const receive = Effect.forever(
      pull.pipe(
        Effect.flatMap((frames) =>
          Effect.forEach(
            frames,
            (frame) =>
              Effect.callback<void, MediaConnectionClosed>((resume) => {
                if (typeof frame === "string")
                  return resume(Effect.fail(new MediaConnectionClosed()));
                stream.write(frame, (error) =>
                  resume(error ? Effect.fail(new MediaConnectionClosed()) : Effect.void),
                );
              }),
            { discard: true },
          ),
        ),
      ),
    );
    const send = Stream.fromAsyncIterable<Buffer, MediaConnectionClosed>(
      stream,
      () => new MediaConnectionClosed(),
    ).pipe(
      Stream.runForEach((bytes) =>
        Effect.gen(function* () {
          for (let start = 0; start < bytes.length; start += 48 * 1024) {
            yield* writer.write(bytes.subarray(start, start + 48 * 1024));
          }
        }),
      ),
    );
    return yield* Effect.raceFirst(
      Effect.gen(function* () {
        const first = yield* reader.pull;
        const frame = first[0];
        if (typeof frame !== "string" && frame[0] === 0) {
          const message = decodeNoiseMediaFrame(frame);
          if (
            message?.kind !== "control" ||
            (message.control.op !== "http" && message.control.op !== "ws")
          )
            return yield* new MediaConnectionClosed();
          const request = message.control;
          if (
            !allowed(
              request.op === "ws" ? "GET" : request.method,
              request.path,
              request.op === "ws",
            )
          )
            return yield* new MediaConnectionClosed();
          buffered = first.slice(1);
          return yield* serveBrowserNoiseMedia(
            request,
            stream,
            { pull, upgrade: reader.upgrade },
            writer,
            host !== null,
          );
        }
        if (guest || host) return yield* new MediaConnectionClosed();
        buffered = first;
        return yield* Effect.raceFirst(receive, send);
      }),
      untilRevoked,
    ).pipe(Effect.as(HttpServerResponse.empty()));
  },
  Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty())),
);

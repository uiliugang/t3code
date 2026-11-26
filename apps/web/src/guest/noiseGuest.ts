import {
  CONNECT_NOISE_PATH,
  GuestRedeemRequest,
  NoiseGuestRequest,
  NoiseGuestReply,
  isNoiseGuestRoute,
} from "@t3tools/contracts";
import { NoiseApproval } from "@t3tools/client-runtime/relay";
import { makeNoiseRpcSocket, NOISE_RPC_HIGH_WATER_MARK } from "@t3tools/shared/noiseRpcSocket";
import { parseUrl } from "@t3tools/shared/url";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { makeNoiseGuestFetch } from "../connection/noiseMedia";

const Route = Schema.Struct({ env: Schema.String, pin: Schema.String, relay: Schema.String });
const Stored = Schema.Struct({ ...Route.fields, token: Schema.optionalKey(Schema.String) });
type Route = typeof Route.Type;
type Entry = Route & { shareId: string; token?: string };
const decodeStored = Schema.decodeOption(Schema.fromJsonString(Stored));
const decodeRedeem = Schema.decodeOption(Schema.fromJsonString(GuestRedeemRequest));
const decodeReply = Schema.decodeOption(Schema.fromJsonString(NoiseGuestReply));
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(NoiseGuestRequest));
const keyPrefix = "t3code:noise-guest:";
let active: Entry | null = null;
let encrypted = false;
const lifetime = new AbortController();
export const isNoiseGuest = () => encrypted;

function load(id: string) {
  try {
    return Option.getOrNull(decodeStored(sessionStorage.getItem(keyPrefix + id) ?? ""));
  } catch {
    return null;
  }
}
function remember(entry: Entry) {
  try {
    sessionStorage.setItem(keyPrefix + entry.shareId, JSON.stringify(entry));
  } catch {}
}
function validRoute(route: Route) {
  const relay = parseUrl(route.relay);
  return (
    relay?.protocol === "https:" &&
    relay.origin === route.relay &&
    relay.origin !== window.location.origin &&
    NoiseApproval.readNoisePin(
      "t3noise://pair#" + new URLSearchParams({ env: route.env, pin: route.pin }),
    ) !== null
  );
}
export function readNoiseGuestEntry(hash: string, existingShareId: string | null) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  active = null;
  encrypted = false;
  if (params.has("noise")) {
    encrypted = true;
    const invite = params.get("invite") ?? "";
    const share = invite.split(".")[0] ?? "";
    const route = {
      env: params.get("env") ?? "",
      pin: params.get("pin") ?? "",
      relay: params.get("relay") ?? "",
    };
    if (
      params.get("noise") !== "1" ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(invite) ||
      invite.length > 512 ||
      ["noise", "invite", "pin", "env", "relay"].some((key) => params.getAll(key).length !== 1) ||
      !validRoute(route)
    )
      return { shareId: null, credential: null };
    const saved = load(share);
    const token =
      saved?.env === route.env && saved.pin === route.pin && saved.relay === route.relay
        ? saved.token
        : undefined;
    active = { ...route, shareId: share, ...(token ? { token } : {}) };
    remember(active);
    return { shareId: share, credential: invite };
  }
  if (!hash && new URLSearchParams(window.location.search).get("noise") === "1") encrypted = true;
  if (!hash && existingShareId) {
    const record = load(existingShareId);
    if (record) {
      encrypted = true;
      if (validRoute(record)) active = { ...record, shareId: existingShareId };
      return { shareId: existingShareId, credential: null };
    }
  }
  return encrypted ? { shareId: existingShareId, credential: null } : null;
}

class GuestChannelError extends Schema.TaggedError<
  GuestChannelError,
  { readonly brand: unique symbol }
>()("GuestChannelError", {}) {}
const invalid = () => new GuestChannelError({});
const handshake = Effect.fn("guest.noise.handshake")(
  function* (route: Route, request: NoiseGuestRequest) {
    const pin = NoiseApproval.readNoisePin(
      "t3noise://pair#" + new URLSearchParams({ env: route.env, pin: route.pin }),
    );
    if (!pin) return yield* invalid();
    const wasm = yield* Effect.tryPromise({
      try: async () => {
        const wasm = await import("@t3tools/shared/connectNoiseWasm");
        await wasm.initializeConnectNoise();
        return wasm;
      },
      catch: invalid,
    });
    const peer = yield* Effect.acquireRelease(
      Effect.try({
        try: () => wasm.makeNoiseInitiator(pin.environmentId, pin.key),
        catch: invalid,
      }),
      (p) => Effect.sync(() => p.release()),
    );
    const endpoint = new URL(route.relay);
    endpoint.protocol = "wss:";
    endpoint.pathname = CONNECT_NOISE_PATH;
    const ws = yield* Socket.makeWebSocket(endpoint.href, {
      openTimeout: "8 seconds",
      highWaterMark: NOISE_RPC_HIGH_WATER_MARK,
    });
    const reader = yield* ws.reader;
    const writer = yield* ws.writer;
    const exchange = Effect.fn("guest.noise.exchange")(function* (payload: Uint8Array) {
      yield* writer.write(yield* Effect.try({ try: () => peer.write(payload), catch: invalid }));
      const batch = yield* reader.pull;
      const record = batch[0];
      if (batch.length !== 1 || typeof record === "string" || record.length > 12288)
        return yield* invalid();
      return yield* Effect.try({ try: () => peer.read(record), catch: invalid });
    });
    if ((yield* exchange(new Uint8Array())).length !== 32) return yield* invalid();
    const encoded = yield* encodeRequest(request);
    const reply = decodeReply(
      new TextDecoder().decode(yield* exchange(new TextEncoder().encode(encoded))),
    );
    if (Option.isNone(reply)) return yield* invalid();
    return { reply: reply.value, socket: makeNoiseRpcSocket(reader, writer, peer) };
  },
  Effect.timeout("15 seconds"),
  Effect.provide(Socket.layerWebSocketConstructorGlobal),
);
class GuestSessionRejected extends Schema.TaggedError<
  GuestSessionRejected,
  { readonly brand: unique symbol }
>()("GuestSessionRejected", {}) {}
const rejected = Schema.is(GuestSessionRejected);
const forbidden = () => new Response(null, { status: 403 });

export function noiseGuestFetch(path: string, init?: RequestInit): Promise<Response> | null {
  if (!encrypted) return null;
  const entry = active;
  if (!entry) return Promise.resolve(forbidden());
  if (path === "/api/guest/redeem" && init?.method === "POST" && typeof init.body === "string") {
    const input = decodeRedeem(init.body);
    if (Option.isNone(input) || input.value.credential.split(".")[0] !== entry.shareId)
      return Promise.resolve(forbidden());
    return Effect.runPromise(
      Effect.scoped(handshake(entry, { mode: "guest-redeem", ...input.value })),
      { signal: init.signal ?? undefined },
    ).then(({ reply }) => {
      if (reply.status !== "guest-redeemed" || reply.shareId !== entry.shareId || active !== entry)
        return forbidden();
      active = { ...entry, token: reply.token };
      remember(active);
      return new Response(null, { status: 204 });
    });
  }
  const { token, shareId } = entry;
  if (!token || !isNoiseGuestRoute(init?.method ?? "GET", path, shareId))
    return Promise.resolve(forbidden());
  const open = handshake(entry, { mode: "guest-session", shareId, token }).pipe(
    Effect.flatMap(({ reply, socket }) =>
      reply.status === "guest-ready"
        ? Effect.succeed({ socket })
        : Effect.fail(new GuestSessionRejected({})),
    ),
  );
  return makeNoiseGuestFetch(
    open,
    lifetime.signal,
    shareId,
  )("https://noise.invalid" + path, init).catch((cause: unknown) => {
    if (rejected(cause)) return forbidden();
    throw cause;
  });
}

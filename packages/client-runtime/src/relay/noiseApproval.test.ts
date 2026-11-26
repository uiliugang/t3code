import { expect, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Socket from "effect/socket/Socket";
import { ManagedRelayDpopSigner } from "./managedRelay.ts";
import { openNoiseRpc, readNoisePin, verifyNoiseApproval } from "./noiseApproval.ts";

const key = new Uint8Array(32).fill(3);
const pinText = Base64Url.encode(key);
const link = `t3noise://pair#env=env-1&pin=${pinText}`;

it("reads a pinned environment from the fragment and rejects ambiguous or malformed links", () => {
  expect(readNoisePin(link)).toEqual({ environmentId: "env-1", key });
  for (const invalid of [
    link.replace("#", "?"),
    link.replace("pair#", "pair/path#"),
    link + "&env=env-2",
    link + "&pin=" + pinText,
    link.replace("env-1", "%20"),
    link.replace(pinText, pinText.slice(1)),
    link.replace(pinText, pinText + "="),
    link.replace(pinText, pinText.slice(0, -1) + "!"),
  ]) {
    expect(readNoisePin(invalid), invalid).toBeNull();
  }
});

it.effect(
  "sends only the empty Noise hello when the relay cannot authenticate the pinned host",
  () =>
    Effect.gen(function* () {
      const opened: string[] = [];
      const writes: Array<string | Uint8Array> = [];
      const events = new EventTarget();
      const socket = Object.assign(events, {
        readyState: 1,
        send(data: string | Uint8Array) {
          writes.push(data);
          events.dispatchEvent(new MessageEvent("message", { data: new Uint8Array(80) }));
        },
        close() {},
      });
      const hello = new Uint8Array(48).fill(1);
      let released = false;
      const check = (wsBaseUrl: string) =>
        verifyNoiseApproval({
          pin: readNoisePin(link)!,
          wsBaseUrl,
          credential: "bootstrap-secret",
          createPeer: () => ({
            write(bytes) {
              expect(bytes).toHaveLength(0);
              return hello;
            },
            read() {
              throw new Error("Noise tag verification failed");
            },
            release() {
              released = true;
            },
          }),
        }).pipe(
          Effect.provideService(Socket.WebSocketConstructor, (url) => {
            opened.push(url);
            return socket;
          }),
          Effect.provideService(ManagedRelayDpopSigner, {
            thumbprint: Effect.die("Unexpected device key access"),
            createProof: () => Effect.die("Unexpected signing request"),
          }),
          Effect.flip,
        );

      for (const address of ["invalid", "ws://relay.test/ws", "wss://user:pass@relay.test/ws"]) {
        expect(yield* check(address)).toMatchObject({ _tag: "NoiseApprovalError" });
      }
      expect(opened).toEqual([]);
      expect(yield* check("wss://relay.test/ws")).toMatchObject({ _tag: "NoiseApprovalError" });
      expect(opened).toEqual(["wss://relay.test/api/connect/e2ee/v1"]);
      expect(writes).toEqual([hello]);
      expect(released).toBe(true);
    }),
);

it.effect("refuses an approval-only host and closes the peer before returning the RPC error", () =>
  Effect.gen(function* () {
    const messages: Uint8Array[] = [];
    let released = false;
    const events = new EventTarget();
    const raw = Object.assign(events, {
      readyState: 1,
      send(data: Uint8Array | string) {
        if (typeof data === "string") throw new Error("Unexpected plaintext");
        messages.push(data);
        const reply =
          messages.length === 1
            ? new Uint8Array(32)
            : new TextEncoder().encode(JSON.stringify({ status: "approved" }));
        events.dispatchEvent(new MessageEvent("message", { data: reply }));
      },
      close() {},
    });
    const error = yield* openNoiseRpc({
      pin: readNoisePin(link)!,
      credential: "one-time",
      wsBaseUrl: "wss://relay.test/ws",
      createPeer: () => ({
        read: (bytes) => bytes,
        write: (bytes) => bytes,
        release() {
          released = true;
        },
      }),
    }).pipe(
      Effect.provideService(Socket.WebSocketConstructor, () => raw),
      Effect.provideService(ManagedRelayDpopSigner, {
        thumbprint: Effect.die("Unexpected pending code"),
        createProof: () => Effect.succeed("device-proof"),
      }),
      Effect.flip,
    );
    expect(error).toMatchObject({ _tag: "NoiseApprovalError" });
    expect(messages).toHaveLength(2);
    expect(JSON.parse(new TextDecoder().decode(messages[1]))).toMatchObject({
      mode: "rpc",
      orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
    });
    expect(released).toBe(true);
  }),
);

it.effect("hands the first queued RPC record and the live peer to the session scope", () =>
  Effect.gen(function* () {
    const events = new EventTarget();
    const emit = (data: Uint8Array) => events.dispatchEvent(new MessageEvent("message", { data }));
    const encoder = new TextEncoder();
    let released = false;
    const raw = Object.assign(events, {
      readyState: 1,
      send(data: Uint8Array | string) {
        if (typeof data === "string") throw new Error("Unexpected plaintext");
        if (data.length === 0) {
          emit(new Uint8Array(32));
          return;
        }
        emit(
          encoder.encode(
            JSON.stringify({
              status: "connected",
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
              auth: {
                policy: "remote-reachable",
                bootstrapMethods: [],
                sessionMethods: [],
                sessionCookieName: "test",
              },
              scopes: ["orchestration:read"],
              expiresAt: "2026-01-01T00:00:00.000Z",
            }),
          ),
        );
        emit(Uint8Array.of(0, 0, 0, 2, 123, 125));
      },
      close() {},
    });
    yield* Effect.gen(function* () {
      const reply = yield* openNoiseRpc({
        pin: readNoisePin(link)!,
        credential: "one-time",
        wsBaseUrl: "wss://relay.test/ws",
        createPeer: () => ({
          read: (bytes) => bytes,
          write: (bytes) => bytes,
          release() {
            released = true;
          },
        }),
      });
      if (reply.status !== "connected") throw new Error("Expected an RPC session");
      expect(yield* (yield* reply.socket.reader).pull).toEqual([encoder.encode("{}")]);
      expect(released).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provideService(Socket.WebSocketConstructor, () => raw),
      Effect.provideService(ManagedRelayDpopSigner, {
        thumbprint: Effect.die("Unexpected pending code"),
        createProof: () => Effect.succeed("device-proof"),
      }),
    );
    expect(released).toBe(true);
  }),
);

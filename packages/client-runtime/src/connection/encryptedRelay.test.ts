import { expect, it } from "@effect/vitest";
import {
  CONNECT_NOISE_KEY_PATH,
  EnvironmentId,
  connectDeviceVerificationCode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Socket from "effect/socket/Socket";
import { vi } from "vite-plus/test";

import { CloudSession, NoiseConnections } from "../platform/capabilities.ts";
import { ManagedRelayClient, ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { makeEncryptedRelay } from "./encryptedRelay.ts";

const environmentId = EnvironmentId.make("test-host");
const key = new Uint8Array(32).fill(7);
const publicLink = `t3noise://pair#env=${environmentId}&pin=${Base64Url.encode(key)}`;
const verificationCode = connectDeviceVerificationCode("test-device");

it.effect("only permits compatibility for a legacy response before any host key is saved", () =>
  Effect.gen(function* () {
    let compatibility = false;
    let savedKey: string | null = null;
    let hostAuthenticates = true;
    const website = yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(globalThis, "fetch")),
      (mock) => Effect.sync(() => mock.mockRestore()),
    );
    const { layer } = makeEncryptedRelay({
      enabled: () => true,
      storage: Effect.succeed({
        getItem: () => Effect.succeed(null),
        setItem: () => Effect.void,
      }),
      automatic: Effect.succeed({
        storage: {
          getItem: () => Effect.sync(() => savedKey),
          setItem: (_id, value) =>
            Effect.sync(() => {
              savedKey = value;
            }),
        },
        allowCompatibility: Effect.sync(() => compatibility),
      }),
      loadPeer: Effect.succeed((id, discovered) => {
        expect(id).toBe(environmentId);
        expect(discovered).toEqual(key);
        return {
          write: (bytes) => bytes,
          read: (bytes) => {
            if (!hostAuthenticates) throw new Error("Wrong host key");
            return bytes;
          },
          release() {},
        };
      }),
    });
    const dependencies = Layer.mergeAll(
      Layer.mock(CloudSession)({
        identity: Effect.succeedNone,
        clerkToken: Effect.succeed("token"),
      }),
      Layer.mock(ManagedRelayClient)({
        relayUrl: "https://relay.test",
        connectEnvironment: () =>
          Effect.succeed({
            environmentId,
            credential: "bootstrap",
            expiresAt: "2026-11-28T00:00:00Z",
            endpoint: {
              httpBaseUrl: "https://host.test",
              wsBaseUrl: "wss://host.test",
              providerKind: "cloudflare_tunnel",
            },
          }),
      }),
      Layer.mock(ManagedRelayDpopSigner)({
        createProof: () => Effect.succeed("proof"),
        thumbprint: Effect.succeed("test-device"),
      }),
      Layer.succeed(Socket.WebSocketConstructor, () => {
        const target = new EventTarget();
        let messages = 0;
        return Object.assign(target, {
          readyState: 1,
          send() {
            const data =
              messages++ === 0
                ? new Uint8Array(32)
                : new TextEncoder().encode(JSON.stringify({ status: "pending", verificationCode }));
            target.dispatchEvent(new MessageEvent("message", { data }));
          },
          close() {},
        });
      }),
    );
    const noise = yield* NoiseConnections.pipe(
      Effect.provide(layer.pipe(Layer.provide(dependencies))),
    );
    const connect = () => noise.openRelay!(environmentId).pipe(Effect.scoped);

    website.mockImplementation(async () => new Response(null, { status: 404 }));
    expect(yield* Effect.flip(connect())).toMatchObject({ reason: "configuration" });
    compatibility = true;
    expect(yield* connect()).toBeNull();
    website.mockImplementation(
      async () =>
        new Response("<!doctype html>", {
          headers: { "Content-Type": "text/html" },
        }),
    );
    expect(yield* connect()).toBeNull();
    website.mockImplementation(async () => new Response(null, { status: 502 }));
    expect(yield* Effect.flip(connect())).toMatchObject({ reason: "transport" });
    website.mockImplementation(
      async () => new Response(publicLink.replace("test-host", "other-host")),
    );
    expect(yield* Effect.flip(connect())).toMatchObject({ reason: "configuration" });
    expect(savedKey).toBeNull();

    website.mockImplementation(async (request, init) => {
      expect(String(request)).toBe("https://host.test" + CONNECT_NOISE_KEY_PATH);
      expect(init).toMatchObject({ redirect: "error", credentials: "omit" });
      return new Response(publicLink);
    });
    expect(yield* Effect.flip(connect())).toMatchObject({
      reason: "approval-pending",
      verificationCode,
    });
    expect(savedKey).toBe(Base64Url.encode(key));
    website.mockClear();
    hostAuthenticates = false;
    expect(yield* Effect.flip(connect())).toMatchObject({ reason: "authentication" });
    expect(website).not.toHaveBeenCalled();
  }),
);

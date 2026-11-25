import {
  makeEncryptedRelay,
  openLocalMediaOrigins,
  type Wakeups,
} from "@t3tools/client-runtime/connection";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import * as Layer from "effect/Layer";
import { NoiseApproval } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { makeBrowserMediaTransport } from "./noiseMedia";

const storagePrefix = "t3code:noise:";
const hostKeyError = () =>
  new NoiseApproval.NoiseApprovalError({ message: "Host key storage unavailable" });
const encryptedRelay = makeEncryptedRelay({
  enabled: () => true,
  storage: Effect.succeed({
    getItem: (key) =>
      Effect.try({
        try: () => window.localStorage.getItem(storagePrefix + key),
        catch: hostKeyError,
      }),
    setItem: (key, value, expected) =>
      Effect.tryPromise({
        try: () =>
          navigator.locks.request(storagePrefix + key, () => {
            const storage = window.localStorage;
            if (storage.getItem(storagePrefix + key) !== expected) return false;
            storage.setItem(storagePrefix + key, value);
            return true;
          }),
        catch: hostKeyError,
      }),
  }),
  loadPeer: Effect.tryPromise({
    try: async () => {
      const { initializeConnectNoise, makeNoiseInitiator } =
        await import("@t3tools/shared/connectNoiseWasm");
      await initializeConnectNoise();
      return makeNoiseInitiator;
    },
    catch: () => new NoiseApproval.NoiseApprovalError({ message: "Could not load Noise" }),
  }),
});

export const enrollNoiseConnection = encryptedRelay.enroll;

export const layerNoiseConnections = Layer.effect(
  ClientCapabilities.NoiseConnections,
  Effect.gen(function* () {
    const noise = yield* ClientCapabilities.NoiseConnections;
    const create = globalThis.window?.desktopBridge?.openNoiseMediaListener;
    if (!create)
      return ClientCapabilities.NoiseConnections.of({
        ...noise,
        openBrowserMedia: Effect.fn("web.noiseMedia.openBrowserMedia")((id, key) =>
          Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (lifetime) => Effect.sync(() => lifetime.abort()),
          ).pipe(
            Effect.map((lifetime) =>
              makeBrowserMediaTransport(noise.open(id, key, "media"), lifetime.signal),
            ),
          ),
        ),
      });
    return ClientCapabilities.NoiseConnections.of({
      ...noise,
      openMediaOrigins: Effect.fn("web.noiseMedia.openOrigins")((id, key) =>
        openLocalMediaOrigins(create, noise.open(id, key, "media")),
      ),
    });
  }),
).pipe(Layer.provide(encryptedRelay.layer));

export const otherWindowPinChanges = Stream.callback<Wakeups.ConnectionWakeup>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const changed = (event: StorageEvent) => {
        if (
          event.storageArea === window.localStorage &&
          event.key?.startsWith(storagePrefix) &&
          event.newValue !== null
        ) {
          Queue.offerUnsafe(queue, {
            type: "host-key-changed",
            environmentId: event.key.slice(storagePrefix.length),
          });
        }
      };
      window.addEventListener("storage", changed);
      return changed;
    }),
    (changed) => Effect.sync(() => window.removeEventListener("storage", changed)),
  ).pipe(Effect.asVoid),
);

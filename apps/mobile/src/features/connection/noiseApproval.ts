import { makeEncryptedRelay } from "@t3tools/client-runtime/connection";
import { NoiseApproval } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import { openAndroidMediaOrigins } from "./noiseMedia";
import { Platform } from "react-native";
import { MobileSecureStorage } from "../../persistence/mobile-secure-storage";
import { MobilePreferencesStore } from "../../persistence/mobile-preferences";

const keyFor = (id: EnvironmentId) =>
  "connect-noise." + Base64Url.encode(new TextEncoder().encode(id));
const discoveredKeyFor = (id: EnvironmentId) => keyFor(id) + ".discovered";
const discoveredKeyLock = Semaphore.makeUnsafe(1);

const { layer, enroll: enrollNoiseConnection } = makeEncryptedRelay({
  storage: MobileSecureStorage.pipe(
    Effect.map((store) => ({
      getItem: (id: EnvironmentId) => store.getItem(keyFor(id)),
      setItem: (id: EnvironmentId, value: string) => store.setItem(keyFor(id), value),
    })),
  ),
  enabled: () => Platform.OS === "android",
  ...(Platform.OS === "android"
    ? {
        automatic: Effect.gen(function* () {
          const secureStore = yield* MobileSecureStorage;
          const preferences = Option.getOrNull(yield* Effect.serviceOption(MobilePreferencesStore));
          return {
            storage: {
              getItem: (id: EnvironmentId) => secureStore.getItem(discoveredKeyFor(id)),
              setItem: Effect.fn("connectNoise.rememberDiscoveredKey")(function* (
                id: EnvironmentId,
                value: string,
              ) {
                const current = yield* secureStore.getItem(discoveredKeyFor(id));
                if (current !== null) return current === value;
                yield* secureStore.setItem(discoveredKeyFor(id), value);
                return true;
              }, discoveredKeyLock.withPermits(1)),
            },
            allowCompatibility:
              preferences?.load.pipe(
                Effect.match({
                  onSuccess: (saved) => saved.allowT3ConnectWithoutE2ee === true,
                  onFailure: () => false,
                }),
              ) ?? Effect.succeed(false),
          };
        }),
      }
    : {}),
  loadPeer: Effect.tryPromise({
    try: async () => {
      const { requireNativeModule } = await import("expo");
      const native = requireNativeModule<{
        ConnectNoisePeer: new (id: string, key: Uint8Array) => NoiseApproval.NoiseApprovalPeer;
      }>("T3NativeControls");
      return (id, key) => new native.ConnectNoisePeer(id, key);
    },
    catch: () => new NoiseApproval.NoiseApprovalError({ message: "Could not load Noise" }),
  }),
});

export { enrollNoiseConnection };

export const layerNoiseConnections = Layer.effect(
  ClientCapabilities.NoiseConnections,
  Effect.gen(function* () {
    const noise = yield* ClientCapabilities.NoiseConnections;
    return {
      ...noise,
      openMediaOrigins: (environmentId, key) =>
        openAndroidMediaOrigins(noise.open(environmentId, key, "media")),
    } satisfies ClientCapabilities.NoiseConnections["Service"];
  }),
).pipe(Layer.provide(layer));

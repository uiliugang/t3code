import { expect, it } from "@effect/vitest";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  RelayConnectionTarget,
  type ConnectionCatalogEntry,
  type NetworkStatus,
} from "@t3tools/client-runtime/connection";
import { Discovery } from "@t3tools/client-runtime/relay";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Base64Url from "effect/encoding/Base64Url";
import { vi } from "vite-plus/test";
import { MobileSecureStorage } from "../../persistence/mobile-secure-storage";
import { enrollNoiseConnection } from "./noiseApproval";

vi.mock("expo-secure-store", () => ({}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

it.effect(
  "retains a changed pin until confirmed and ends the previous connection before replacing it",
  () =>
    Effect.gen(function* () {
      const pin = {
        environmentId: EnvironmentId.make("mobile-test"),
        key: new Uint8Array(32).fill(1),
      };
      const old = Base64Url.encode(new Uint8Array(32));
      let stored = old;
      let connected = true;
      const entry: ConnectionCatalogEntry = {
        target: new RelayConnectionTarget({
          environmentId: pin.environmentId,
          label: "Existing host",
        }),
        profile: Option.none(),
        enabled: true,
      };
      const dependencies = Layer.mergeAll(
        Layer.mock(MobileSecureStorage)({
          getItem: () => Effect.succeed(stored),
          setItem: (_, value) =>
            Effect.sync(() => {
              expect(connected).toBe(false);
              stored = value;
            }),
        }),
        Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
          entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
            new Map([[pin.environmentId, entry]]),
          ),
          networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
          setEnabled: (_, enabled) =>
            Effect.sync(() => {
              if (enabled) expect(stored).toBe(Base64Url.encode(pin.key));
              connected = enabled;
            }),
          stateChanges: () => Stream.succeed(AVAILABLE_CONNECTION_STATE),
          register: () => Effect.succeed(true),
          setCompatibility: () => Effect.void,
        }),
        Layer.succeed(Discovery.RelayEnvironmentDiscovery, {
          state: yield* SubscriptionRef.make(Discovery.EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE),
          refresh: Effect.void,
        }),
      );
      const enroll = (replacePin: boolean) =>
        enrollNoiseConnection({ pin, replacePin }).pipe(Effect.provide(dependencies));
      expect(yield* enroll(false)).toEqual({ status: "changed" });
      expect(stored).toBe(old);
      expect(connected).toBe(true);
      expect(yield* enroll(true)).toEqual({ status: "enrolled" });
      expect(stored).toBe(Base64Url.encode(pin.key));
      expect(connected).toBe(true);
    }),
);

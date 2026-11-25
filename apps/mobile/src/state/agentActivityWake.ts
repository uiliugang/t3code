import { ConnectionBlockedError } from "@t3tools/client-runtime/connection";
import { ClientCapabilities, ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CONNECTION_CATALOG_KEY } from "../connection/catalog-store";
import { readWakePreferences } from "../features/agent-awareness/wakePreferences";
import { cloudClerk } from "../features/cloud/clerkInstance";
import { resolveRelayClerkTokenOptions } from "../features/cloud/publicConfig";
import { layerNoiseConnections } from "../features/connection/noiseApproval";
import { MobileSecureStorage } from "../persistence/mobile-secure-storage";
import { fetchNoiseAgentActivity } from "../rpc/agentActivity";

const decodeCatalog = Schema.decodeEffect(Schema.fromJsonString(ConnectionCatalogDocument));
const denied = () =>
  new ConnectionBlockedError({ reason: "permission", detail: "Private activity is unavailable." });
let loadingClerk: Promise<unknown> | undefined;

export const readNoiseAgentActivity = Effect.fn("MobileWake.readNoiseAgentActivity")(function* (
  environment: string,
  userId: string,
  deviceId: string,
) {
  const environmentId = EnvironmentId.make(environment);
  const clerk = cloudClerk;
  if (!clerk) return yield* denied();
  return yield* Effect.gen(function* () {
    const storage = yield* MobileSecureStorage;
    const noise = yield* ClientCapabilities.NoiseConnections;
    const savedPin = Effect.gen(function* () {
      const raw = yield* storage.getItem(CONNECTION_CATALOG_KEY);
      if (!raw) return yield* denied();
      const catalog = yield* decodeCatalog(raw);
      if (
        catalog.disabledEnvironmentIds.includes(environmentId) ||
        !catalog.targets.some(
          (target) =>
            target._tag === "RelayConnectionTarget" && target.environmentId === environmentId,
        )
      ) {
        return yield* denied();
      }
      const pin = yield* noise.readPin(environmentId);
      if (!pin) return yield* denied();
      return pin;
    });
    const pin = yield* savedPin;
    if (!clerk.loaded) {
      loadingClerk ??= clerk
        .load({ standardBrowser: false, experimental: { runtimeEnvironment: "headless" } })
        .finally(() => {
          loadingClerk = undefined;
        });
      const ready = loadingClerk;
      yield* Effect.tryPromise({ try: () => ready, catch: denied });
    }
    const session = clerk.session;
    if (!session || session.user.id !== userId) return yield* denied();
    const cloud = yield* ClientCapabilities.CloudSession;
    const preferences = yield* readWakePreferences(
      environmentId,
      deviceId,
      yield* cloud.clerkToken,
    );
    const states =
      preferences.notificationsEnabled || preferences.liveActivitiesEnabled
        ? yield* noise.open(environmentId, pin).pipe(Effect.flatMap(fetchNoiseAgentActivity))
        : [];
    const current = yield* savedPin;
    if (
      clerk.session?.id !== session.id ||
      !pin.every((byte, i) => byte === current[i]) ||
      clerk.session.user.id !== userId ||
      states.some((row) => row.environmentId !== environmentId)
    )
      return yield* denied();
    return { states, preferences };
  }).pipe(
    Effect.scoped,
    Effect.provide(layerNoiseConnections),
    Effect.provideService(ClientCapabilities.CloudSession, {
      identity: Effect.sync(() =>
        clerk.session?.user.id === userId ? Option.some({ accountId: userId }) : Option.none(),
      ),
      clerkToken: Effect.tryPromise({
        try: async () => {
          const session = clerk.session;
          if (session?.user.id !== userId) throw denied();
          const token = await session.getToken(resolveRelayClerkTokenOptions());
          if (!token || clerk.session?.id !== session.id) throw denied();
          return token;
        },
        catch: denied,
      }),
    }),
    Effect.timeout("25 seconds"),
  );
});

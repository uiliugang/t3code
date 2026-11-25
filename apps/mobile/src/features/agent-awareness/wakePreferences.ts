import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type { RelayAgentAwarenessPreferences } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";

export const readWakePreferences = Effect.fn("MobileWake.readPreferences")(function* (
  environmentId: string,
  deviceId: string,
  clerkToken: string,
) {
  const relay = yield* ManagedRelay.ManagedRelayClient;
  const [devices, environments] = yield* Effect.all(
    [relay.listDevices({ clerkToken }), relay.listEnvironments({ clerkToken })],
    { concurrency: "unbounded" },
  );
  const device = devices.find((item) => item.deviceId === deviceId && item.platform === "android");
  const link = environments.find(
    (item) => item.environmentId === environmentId,
  )?.activityPreferences;
  return {
    liveActivitiesEnabled:
      device?.liveActivities.enabled === true && link?.liveActivitiesEnabled === true,
    notificationsEnabled:
      device?.notifications.enabled === true && link?.notificationsEnabled === true,
    notifyOnApproval: device?.notifications.notifyOnApproval === true,
    notifyOnInput: device?.notifications.notifyOnInput === true,
    notifyOnCompletion: device?.notifications.notifyOnCompletion === true,
    notifyOnFailure: device?.notifications.notifyOnFailure === true,
  } satisfies RelayAgentAwarenessPreferences;
});

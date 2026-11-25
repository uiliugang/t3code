import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { EnvironmentId } from "@t3tools/contracts";
import type {
  RelayClientDeviceRecord,
  RelayClientEnvironmentRecord,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";
import { readWakePreferences } from "./wakePreferences";

const device = {
  deviceId: "phone",
  label: "Android",
  platform: "android",
  iosMajorVersion: null,
  appVersion: null,
  updatedAt: "2026-01-01T12:00:00Z",
  notifications: {
    enabled: true,
    notifyOnApproval: false,
    notifyOnFailure: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
  },
  liveActivities: { enabled: true },
} satisfies RelayClientDeviceRecord;

const link = {
  environmentId: EnvironmentId.make("home"),
  label: "Home",
  linkedAt: "2026-01-01T12:00:00Z",
  endpoint: {
    httpBaseUrl: "https://home.example.test",
    wsBaseUrl: "wss://home.example.test",
    providerKind: "cloudflare_tunnel",
  },
} satisfies RelayClientEnvironmentRecord;

function read(devices: RelayClientDeviceRecord[], environments: RelayClientEnvironmentRecord[]) {
  return readWakePreferences("home", "phone", "test").pipe(
    Effect.provide(
      Layer.mock(ManagedRelay.ManagedRelayClient)({
        relayUrl: "https://relay.example.test",
        listDevices: () => Effect.succeed(devices),
        listEnvironments: () => Effect.succeed(environments),
      }),
    ),
  );
}

it.effect(
  "combines this host and Android device policy, and silences an absent or legacy link",
  () =>
    Effect.gen(function* () {
      const allowed = {
        ...link,
        activityPreferences: { notificationsEnabled: true, liveActivitiesEnabled: false },
      };
      expect(yield* read([device], [allowed])).toMatchObject({
        notificationsEnabled: true,
        liveActivitiesEnabled: false,
        notifyOnApproval: false,
      });
      const disabled = { notificationsEnabled: false, liveActivitiesEnabled: false };
      expect(yield* read([device], [link])).toMatchObject(disabled);
      expect(
        yield* read([device], [{ ...allowed, environmentId: EnvironmentId.make("other") }]),
      ).toMatchObject(disabled);
      expect(yield* read([{ ...device, deviceId: "another" }], [allowed])).toMatchObject(disabled);
      expect(
        yield* read([{ ...device, platform: "ios", iosMajorVersion: 18 }], [allowed]),
      ).toMatchObject(disabled);
      expect(
        yield* read(
          [{ ...device, notifications: { ...device.notifications, enabled: false } }],
          [allowed],
        ),
      ).toMatchObject(disabled);
    }),
);

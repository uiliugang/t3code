import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as FcmDeliveryQueueConsumer from "./FcmDeliveryQueueConsumer.ts";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as FcmDeliveryQueueSender from "./FcmDeliveryQueueSender.ts";
import * as FcmClient from "./FcmClient.ts";
import * as FcmDeliveries from "./FcmDeliveries.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const environment = { environmentId: "env", environmentPublicKey: "key" };
const job = {
  kind: "agent_activity_wake",
  ...environment,
  userId: "user",
  deviceId: "phone",
  token: "fcm-token",
  queuedAt: 0,
} satisfies FcmDeliveries.FcmDeliveryJob;
const preferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const target: LiveActivities.TargetRow = {
  user_id: "user",
  device_id: "phone",
  platform: "android",
  ios_major_version: null,
  app_version: null,
  bundle_id: "com.t3tools.t3code.dev",
  aps_environment: null,
  push_token: "fcm-token",
  push_to_start_token: null,
  preferences_json: encodeJson(preferences),
  activity_push_token: null,
  remote_start_queued_at: null,
  remote_started_at: null,
  ended_at: null,
  last_aggregate_json: null,
  last_live_activity_delivery_at: null,
};
const config = {
  relayIssuer: "https://relay.test",
  fcmServiceAccount: Redacted.make("configured"),
  apns: {
    environment: "sandbox",
    teamId: "unused",
    keyId: "unused",
    bundleId: "unused",
    privateKey: Redacted.make("unused"),
  },
  clerkSecretKey: Redacted.make("unused"),
  clerkPublishableKey: "unused",
  clerkJwtAudience: "unused",
  apnsDeliveryJobSigningSecret: Redacted.make("unused"),
  cloudMintPrivateKey: Redacted.make("unused"),
  cloudMintPublicKey: "unused",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
} satisfies RelayConfiguration.RelayConfiguration["Service"];

function harness() {
  const sent: Array<Parameters<FcmClient.FcmClient["Service"]["sendWake"]>[0]> = [];
  const queued: FcmDeliveries.FcmDeliveryJob[] = [];
  const current = {
    target: { ...target },
    linked: true,
    linkPreferences: { notificationsEnabled: true, liveActivitiesEnabled: true },
    deliveryFailure: null as FcmClient.FcmClientError | null,
  };
  const layer = FcmDeliveries.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RelayConfiguration.RelayConfiguration, config),
        Layer.succeed(FcmDeliveryQueueSender.FcmDeliveryQueueSender, {
          send: (body) =>
            Effect.sync(() => {
              queued.push(body);
            }),
        }),
        Layer.succeed(FcmClient.FcmClient, {
          sendWake: (input) =>
            Effect.suspend(() => {
              if (current.deliveryFailure) return Effect.fail(current.deliveryFailure);
              sent.push(input);
              return Effect.succeed({ unregistered: false });
            }),
        }),
        Layer.mock(LiveActivities.LiveActivities, {
          listTargets: ({ userId }) =>
            Effect.succeed(userId === current.target.user_id ? [current.target] : []),
        }),
        Layer.mock(EnvironmentLinks.EnvironmentLinks, {
          listDeliveryUsersForEnvironment: (input) =>
            Effect.succeed(
              current.linked &&
                input.environmentId === environment.environmentId &&
                input.environmentPublicKey === environment.environmentPublicKey
                ? [{ userId: target.user_id, ...current.linkPreferences }]
                : [],
            ),
          listForUser: ({ userId }) =>
            Effect.succeed(
              current.linked && userId === current.target.user_id
                ? ["env", "muted"].map((id) => ({
                    environmentId: EnvironmentId.make(id),
                    endpoint: {
                      httpBaseUrl: "https://host.test",
                      wsBaseUrl: "wss://host.test",
                      providerKind: "manual" as const,
                    },
                    linkedAt: "2026-01-01T00:00:00.000Z",
                    label: id,
                    activityPreferences:
                      id === "muted"
                        ? { notificationsEnabled: false, liveActivitiesEnabled: false }
                        : current.linkPreferences,
                  }))
                : [],
            ),
        }),
        Layer.succeed(RelayDb.RelayDb, {} as RelayDb.RelayDb["Service"]),
      ),
    ),
  );
  return { sent, queued, current, layer };
}

const expectedWake = {
  token: job.token,
  packageName: target.bundle_id,
  environmentId: environment.environmentId,
  deviceId: job.deviceId,
  userId: job.userId,
};

describe("Android delivery routing", () => {
  it.effect("wakes only linked Android devices with matching notification preferences", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* FcmDeliveries.FcmDeliveries;
      h.current.linked = false;
      yield* service.wake(environment);
      h.current.linked = true;
      h.current.target.platform = "ios";
      yield* service.wake(environment);
      h.current.target.platform = "android";
      h.current.linkPreferences.notificationsEnabled = false;
      h.current.target.preferences_json = encodeJson({
        ...preferences,
        liveActivitiesEnabled: false,
      });
      yield* service.wake(environment);
      h.current.linkPreferences.notificationsEnabled = true;
      yield* service.wake(environment);
      expect(h.sent).toEqual([expectedWake]);
      expect(h.queued).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("queues only routing data and discards old activity and replay jobs", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* FcmDeliveries.FcmDeliveries;
      const input = { target, ...environment, state: { threadId: "thread", headline: "secret" } };
      yield* service.enqueue(input);
      expect(h.queued).toEqual([job]);
      const legacy = { userId: job.userId, deviceId: job.deviceId, token: job.token, queuedAt: 0 };
      yield* service.process({ ...legacy, state: input.state });
      yield* service.process({ ...legacy, state: null, replay: true });
      expect(h.sent).toEqual([]);
      yield* service.process(h.queued[0]);
      expect(h.sent).toEqual([expectedWake]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "rechecks the environment key, expiry, ownership, token and current settings at dispatch",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const service = yield* FcmDeliveries.FcmDeliveries;
        yield* service.process({ ...job, environmentPublicKey: "old-key" });
        yield* service.process({ ...job, token: "old-token" });
        yield* service.process({ ...job, queuedAt: -400_000 });
        yield* service.process({ ...job, userId: "another-user" });
        yield* service.process({ ...job, deviceId: "another-device" });
        h.current.linked = false;
        yield* service.process(job);
        h.current.linked = true;
        h.current.target.preferences_json = encodeJson({
          ...preferences,
          liveActivitiesEnabled: false,
          notificationsEnabled: false,
        });
        yield* service.process(job);
        expect(h.sent).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("replays routing for the registering device's permitted environments only", () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* FcmDeliveries.FcmDeliveries;
      yield* service.replayForDevice({
        ...target,
        last_aggregate_json: "private previous summary",
      });
      expect(h.sent).toEqual([expectedWake]);
      expect(h.queued).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("FCM queue message isolation", () => {
  it.effect.each(["invalid-job", "fcm-rejection"] as const)(
    "retries only the %s message and delivers the rest of its batch",
    (failure) => {
      const h = harness();
      const outcomes = new Map<string, "ack" | "retry">();
      const message = (id: string, body: unknown): Cloudflare.Queues.Message<unknown> => ({
        id,
        body,
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
        attempts: 1,
        ack: () => {
          if (!outcomes.has(id)) outcomes.set(id, "ack");
        },
        retry: () => {
          if (!outcomes.has(id)) outcomes.set(id, "retry");
        },
      });
      const batch = [
        message("failed", failure === "invalid-job" ? {} : job),
        message("healthy", job),
      ];
      return Effect.gen(function* () {
        yield* Stream.fromIterable(batch).pipe(
          Stream.tap((item) =>
            Effect.sync(() => {
              h.current.deliveryFailure =
                item.id === "failed" && failure === "fcm-rejection"
                  ? new FcmClient.FcmClientError({ operation: "send", status: 400 })
                  : null;
            }),
          ),
          Stream.runForEach(FcmDeliveryQueueConsumer.processMessage),
        );
        // Cloudflare ignores Alchemy's final batch acknowledgements for already-retried messages.
        for (const item of batch) item.ack();
        expect([...outcomes]).toEqual([
          ["failed", "retry"],
          ["healthy", "ack"],
        ]);
        expect(h.sent).toHaveLength(1);
      }).pipe(Effect.provide(h.layer));
    },
  );
});

import { and, eq } from "drizzle-orm";
import {
  RelayAgentAwarenessPreferences,
  type RelayDeliveryResult,
  type RelayPublishResponse,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import { relayMobileDevices } from "../persistence/schema.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as FcmDeliveryQueueSender from "./FcmDeliveryQueueSender.ts";
import * as FcmClient from "./FcmClient.ts";

export const FcmDeliveryJob = Schema.Struct({
  userId: Schema.String,
  deviceId: Schema.String,
  token: Schema.String,
  kind: Schema.Literal("agent_activity_wake"),
  environmentId: Schema.String,
  environmentPublicKey: Schema.String,
  queuedAt: Schema.Number,
});
export type FcmDeliveryJob = typeof FcmDeliveryJob.Type;
const decodeJob = Schema.decodeUnknownEffect(FcmDeliveryJob);
const decodePreferences = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentAwarenessPreferences),
);

export class FcmDeliveryError extends Schema.TaggedError<
  FcmDeliveryError,
  { readonly brand: unique symbol }
>()("FcmDeliveryError", {
  operation: Schema.Literals(["enqueue", "decode-job", "invalidate-token"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Failed to ${this.operation} Android notification delivery.`;
  }
}

type WakeError = FcmDeliveryError | FcmClient.FcmClientError;
export type FcmReplayError = WakeError | EnvironmentLinks.EnvironmentLinkListPersistenceError;

export class FcmDeliveries extends Context.Service<
  FcmDeliveries,
  {
    readonly wake: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) => Effect.Effect<
      RelayPublishResponse,
      | WakeError
      | LiveActivities.LiveActivityTargetListPersistenceError
      | EnvironmentLinks.EnvironmentLinkUserListPersistenceError
    >;
    readonly enqueue: (input: {
      readonly target: LiveActivities.TargetRow;
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) => Effect.Effect<RelayDeliveryResult | null, FcmDeliveryError>;
    readonly replayForDevice: (
      target: LiveActivities.TargetRow,
    ) => Effect.Effect<void, FcmReplayError>;
    readonly process: (
      body: unknown,
    ) => Effect.Effect<
      void,
      | WakeError
      | LiveActivities.LiveActivityTargetListPersistenceError
      | EnvironmentLinks.EnvironmentLinkUserListPersistenceError
    >;
  }
>()("t3code-relay/agentActivity/FcmDeliveries") {}

const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const sender = yield* FcmDeliveryQueueSender.FcmDeliveryQueueSender;
  const client = yield* FcmClient.FcmClient;
  const devices = yield* LiveActivities.LiveActivities;
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const db = yield* RelayDb.RelayDb;

  const invalidateToken = (job: { userId: string; deviceId: string; token: string }) =>
    db
      .update(relayMobileDevices)
      .set({ pushToken: null })
      .where(
        and(
          eq(relayMobileDevices.userId, job.userId),
          eq(relayMobileDevices.deviceId, job.deviceId),
          eq(relayMobileDevices.pushToken, job.token),
        ),
      )
      .pipe(
        Effect.mapError((cause) => new FcmDeliveryError({ operation: "invalidate-token", cause })),
      );

  const wakeDevice = Effect.fn("relay.fcm.wakeDevice")(function* (
    environmentId: string,
    user: EnvironmentLinks.AgentAwarenessDeliveryUserRecord,
    target: LiveActivities.TargetRow,
  ) {
    if (target.platform !== "android" || target.user_id !== user.userId || !target.push_token)
      return null;
    const prefs = Option.getOrNull(decodePreferences(target.preferences_json));
    if (
      !prefs ||
      !(
        (user.notificationsEnabled && prefs.notificationsEnabled) ||
        (user.liveActivitiesEnabled && prefs.liveActivitiesEnabled)
      )
    )
      return null;
    const result = yield* client.sendWake({
      token: target.push_token,
      packageName: target.bundle_id,
      environmentId,
      deviceId: target.device_id,
      userId: user.userId,
    });
    if (result.unregistered) {
      yield* invalidateToken({
        userId: user.userId,
        deviceId: target.device_id,
        token: target.push_token,
      });
    }
    return {
      deviceId: target.device_id,
      kind: "push_notification",
      ok: !result.unregistered,
      apnsStatus: null,
      apnsId: null,
      apnsReason: null,
    } satisfies RelayDeliveryResult;
  });

  return FcmDeliveries.of({
    wake: Effect.fn("relay.fcm.wake")(function* (input) {
      const users = yield* links.listDeliveryUsersForEnvironment(input);
      const targetsByUser = yield* Effect.forEach(
        users,
        (user) =>
          devices
            .listTargets({ userId: user.userId })
            .pipe(Effect.map((targets) => targets.map((target) => ({ user, target })))),
        { concurrency: 4 },
      );
      // One rejected token must not interrupt sends to the other registered devices.
      const deliveries = yield* Effect.validate(
        targetsByUser.flat(),
        ({ user, target }) => wakeDevice(input.environmentId, user, target),
        { concurrency: 4 },
      ).pipe(Effect.mapError(([failure]) => failure));
      return { ok: true, deliveries: deliveries.filter((value) => value !== null) };
    }),
    enqueue: Effect.fn("relay.fcm.enqueue")(function* (input) {
      if (input.target.platform !== "android" || !input.target.push_token) return null;
      if (!config.fcmServiceAccount) {
        yield* Effect.logWarning("Android notifications are not configured for this relay");
        return {
          deviceId: input.target.device_id,
          kind: "push_notification",
          ok: false,
          apnsStatus: null,
          apnsReason: null,
          apnsId: null,
        };
      }
      const now = yield* DateTime.now;
      yield* sender
        .send({
          userId: input.target.user_id,
          deviceId: input.target.device_id,
          token: input.target.push_token,
          kind: "agent_activity_wake",
          environmentId: input.environmentId,
          environmentPublicKey: input.environmentPublicKey,
          queuedAt: now.epochMilliseconds,
        })
        .pipe(Effect.mapError((cause) => new FcmDeliveryError({ operation: "enqueue", cause })));
      return {
        deviceId: input.target.device_id,
        kind: "push_notification",
        ok: true,
        queued: true,
        apnsStatus: null,
        apnsReason: null,
        apnsId: null,
      };
    }),
    replayForDevice: Effect.fn("relay.fcm.replayForDevice")(function* (target) {
      if (target.platform !== "android" || !target.push_token) return;
      const environments = yield* links.listForUser({ userId: target.user_id });
      yield* Effect.validate(
        environments,
        (environment) =>
          environment.activityPreferences
            ? wakeDevice(
                environment.environmentId,
                { userId: target.user_id, ...environment.activityPreferences },
                target,
              )
            : Effect.succeed(null),
        { concurrency: 4, discard: true },
      ).pipe(Effect.mapError(([failure]) => failure));
    }),
    process: Effect.fn("relay.fcm.process")(function* (body) {
      // Jobs created before wake-only delivery contain thread data and have no signed environment route.
      if (typeof body === "object" && body !== null && "state" in body) return;
      const job = yield* decodeJob(body).pipe(
        Effect.mapError((cause) => new FcmDeliveryError({ operation: "decode-job", cause })),
      );
      const now = yield* DateTime.now;
      if (now.epochMilliseconds - job.queuedAt > 5 * 60_000) return;
      const users = yield* links.listDeliveryUsersForEnvironment({
        environmentId: job.environmentId,
        environmentPublicKey: job.environmentPublicKey,
      });
      const user = users.find((row) => row.userId === job.userId);
      if (!user) return;
      const targets = yield* devices.listTargets({ userId: user.userId });
      const target = targets.find(
        (row) => row.device_id === job.deviceId && row.push_token === job.token,
      );
      if (target) yield* wakeDevice(job.environmentId, user, target);
    }),
  });
});

export const layer = Layer.effect(FcmDeliveries, make);

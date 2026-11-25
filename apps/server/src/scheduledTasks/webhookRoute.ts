import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { WEBHOOK_KEY_NAME, decryptWebhook } from "./encryptedWebhook.ts";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as Metrics from "../observability/Metrics.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as Workflows from "../workflows/Workflows.ts";
import * as RelayDeliveryProof from "./RelayDeliveryProof.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

/** The relay enforces the same cap. */
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

// The relay records this outcome header.
const WEBHOOK_OUTCOME_HEADER = "x-t3-hook-outcome";

const json = (
  status: number,
  body: Record<string, string>,
  outcome: string,
  headers?: Record<string, string>,
) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { ...headers, [WEBHOOK_OUTCOME_HEADER]: outcome },
  });

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "webhooks",
  Effect.fnUntraced(function* (handlers) {
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    const relayDeliveryProof = yield* RelayDeliveryProof.RelayDeliveryProof;
    const workflows = yield* Workflows.Workflows;
    const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
    /**
     * The endpoint is raw so the signature is checked over the exact body
     * bytes; the service checks the token and signature.
     */
    // Only verified relay deliveries join a trace; direct requests keep their existing context.
    const handler = Effect.fnUntraced(function* ({
      params,
      request,
    }: {
      readonly params: { readonly hookId: string; readonly token: string };
      readonly request: HttpServerRequest.HttpServerRequest;
    }) {
      // The router answers HEAD with the GET route; link checkers probe with HEAD.
      if (request.method === "HEAD") {
        return json(405, { error: "method_not_allowed" }, "method_not_allowed", {
          allow: "GET, POST, PUT, PATCH",
        });
      }
      const contentLength = Number(request.headers["content-length"] ?? "0");
      if (!Number.isFinite(contentLength) || contentLength > WEBHOOK_MAX_BODY_BYTES) {
        return json(413, { error: "body_too_large" }, "body_too_large");
      }
      // Chunked requests carry no content-length, so the reader itself is capped.
      const body = yield* request.arrayBuffer.pipe(
        Effect.map((buffer) => new Uint8Array(buffer)),
        Effect.provideService(
          HttpIncomingMessage.MaxBodySize,
          ByteSize.bytes(WEBHOOK_MAX_BODY_BYTES),
        ),
        Effect.option,
      );
      const tooLarge = (error: string) =>
        Metrics.increment(Metrics.webhookDeliveriesTotal, {
          outcome: "body_too_large",
          source: request.headers["x-t3-relay-delivery-id"] ? "relay" : "direct",
        }).pipe(Effect.as(json(413, { error }, "body_too_large")));
      if (Option.isNone(body)) return yield* tooLarge("body_too_large_or_unreadable");
      if (body.value.byteLength > WEBHOOK_MAX_BODY_BYTES) {
        return yield* tooLarge("body_too_large");
      }

      let headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers[name.toLowerCase()] = value;
      }
      const queryIndex = request.url.indexOf("?");
      // The relay's delivery id and receive time count only with its signed
      // proof; the URL can also be called directly. The receive time matters
      // for requests the relay held while we were offline.
      let hookId = params.hookId;
      let token = params.token;
      let method = request.method;
      let bytes: Uint8Array = body.value;
      let query = queryIndex === -1 ? "" : request.url.slice(queryIndex + 1);
      let relayDeliveryId: string | undefined;
      let relayReceivedAt: string | undefined;
      const encrypted = token === "encrypted-v1";
      if (encrypted) {
        if (method !== "POST")
          return json(405, { error: "method_not_allowed" }, "method_not_allowed");
        const store = yield* Effect.serviceOption(ServerSecretStore);
        const secret = Option.isSome(store)
          ? yield* store.value
              .get(WEBHOOK_KEY_NAME)
              .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()))
          : Option.none<Uint8Array>();
        if (Option.isNone(secret)) return json(404, { error: "hook_not_found" }, "not_found");
        const key = secret.value;
        const now = yield* Clock.currentTimeMillis;
        const decrypted = yield* Effect.tryPromise({
          try: () => decryptWebhook(key, bytes, now, hookId),
          catch: () => "invalid" as const,
        }).pipe(Effect.option);
        if (Option.isNone(decrypted)) return json(400, { error: "invalid_envelope" }, "invalid");
        const inner = decrypted.value;
        hookId = inner.hookId;
        token = inner.token;
        method = inner.method;
        bytes = inner.body;
        query = inner.query;
        headers = Object.fromEntries(
          Object.entries(inner.headers).map(([name, value]) => [name.toLowerCase(), value]),
        );
        // Only the sender's authenticated id and timestamp survive forwarding and offline replay.
        relayDeliveryId = `encrypted:${hookId}:${inner.id}`;
        relayReceivedAt = DateTime.formatIso(DateTime.makeUnsafe(inner.createdAt));
      } else {
        const relay = yield* relayDeliveryProof.verify({ headers, hookId });
        if (Option.isSome(relay)) {
          relayDeliveryId = relay.value.deliveryId;
          relayReceivedAt = relay.value.receivedAt;
        }
      }
      if (hookId.startsWith(Workflows.HOOK_PREFIX)) {
        if (ManagedPolicy.deniedBy(managedPolicy, "webhookTasks") !== undefined) {
          return json(403, { error: "blocked_by_policy" }, "blocked_by_policy");
        }
        // Answered only once the run is stored, so a sender that hears nothing may send again.
        const started = yield* workflows
          .deliver({
            hookId,
            token,
            request: {
              method,
              headers,
              query,
              body: new TextDecoder().decode(bytes),
            },
            ...(relayDeliveryId ? { deliveryId: `relay:${relayDeliveryId}` } : {}),
          })
          .pipe(Effect.result);
        if (Result.isFailure(started)) {
          if (started.failure._tag === "WorkflowInputError") {
            return json(
              400,
              encrypted
                ? { error: "invalid_request" }
                : { error: "invalid_request", problem: started.failure.problem },
              "invalid",
            );
          }
          yield* Effect.logWarning("Workflow hook delivery failed", { hookId });
          return json(500, { error: "internal_error" }, "error");
        }
        return Option.isNone(started.success)
          ? json(404, { error: "hook_not_found" }, "not_found")
          : json(202, encrypted ? {} : { runId: started.success.value.runId }, "accepted");
      }
      const result = yield* scheduledTasks
        .triggerWebhook({
          hookId,
          token,
          method,
          path: `${ScheduledTaskService.WEBHOOK_ROUTE_PREFIX}/${encodeURIComponent(hookId)}`,
          query,
          headers,
          body: bytes,
          bodyText: new TextDecoder().decode(bytes),
          ...(relayDeliveryId ? { relayDeliveryId } : {}),
          ...(relayReceivedAt ? { receivedAt: relayReceivedAt } : {}),
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Webhook delivery failed").pipe(
              Effect.annotateLogs({ hookId }),
              Effect.andThen(Effect.logDebug("Webhook delivery failure cause", { cause })),
              Effect.as({ _tag: "error" as const }),
            ),
          ),
        );

      switch (result._tag) {
        case "accepted":
          return json(202, encrypted ? {} : { deliveryId: result.deliveryId }, result.outcome);
        case "not_found":
          return json(404, { error: "hook_not_found" }, "not_found");
        case "rejected_signature":
          return json(401, { error: "invalid_signature" }, "rejected_signature");
        case "disabled":
          return json(409, { error: "hook_disabled" }, "disabled");
        case "blocked_by_policy":
          return json(403, { error: "blocked_by_policy" }, "blocked_by_policy");
        case "rate_limited":
          return json(429, { error: result.outcome }, result.outcome);
        case "expired":
          return json(410, { error: "delivery_too_old" }, "expired");
        case "error":
          return json(500, { error: "internal_error" }, "error");
      }
    });
    return handlers
      .handleRaw("webhookPost", handler)
      .handleRaw("webhookPut", handler)
      .handleRaw("webhookPatch", handler)
      .handleRaw("webhookGet", handler);
  }),
);

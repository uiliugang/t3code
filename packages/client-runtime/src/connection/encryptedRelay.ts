import { msg } from "gt-i18n";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  RelayConnectionTarget,
} from "./model.ts";
import { environmentMismatchError, mapManagedRelayError } from "./errors.ts";
import { RelayConnectionRegistration } from "./catalog.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { translatableDetail } from "../errors/translatable.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Discovery from "../relay/discovery.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as NoiseApproval from "../relay/noiseApproval.ts";
import { authScopeResponse, type EnvironmentId } from "@t3tools/contracts";
import { RelayEnvironmentConnectScope } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Socket from "effect/socket/Socket";
type Pin = NonNullable<ReturnType<typeof NoiseApproval.readNoisePin>>;
const lock = Semaphore.makeUnsafe(1);
const invalidPin = () =>
  new ConnectionBlockedError({
    reason: "configuration",
    ...translatableDetail(msg("Could not load the environment authorization key.")),
  });

type CreatePeer = (environment: string, key: Uint8Array) => NoiseApproval.NoiseApprovalPeer;
interface PinStorage<E> {
  readonly getItem: (environmentId: EnvironmentId) => Effect.Effect<string | null, E>;
  readonly setItem: (
    environmentId: EnvironmentId,
    value: string,
    expected: string | null,
  ) => Effect.Effect<void | boolean, E>;
}

export function makeEncryptedRelay<R, E>(options: {
  readonly storage: Effect.Effect<PinStorage<E>, never, R>;
  readonly enabled: () => boolean;
  readonly loadPeer: Effect.Effect<CreatePeer, NoiseApproval.NoiseApprovalError>;
}) {
  const layer = Layer.effect(
    ClientCapabilities.NoiseConnections,
    Effect.gen(function* () {
      const store = yield* options.storage;
      const cloud = yield* ClientCapabilities.CloudSession;
      const relay = yield* ManagedRelay.ManagedRelayClient;
      const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
      const websocket = yield* Socket.WebSocketConstructor;

      return ClientCapabilities.NoiseConnections.of({
        readPin: Effect.fn("connectNoise.readPin")(function* (environmentId) {
          if (!options.enabled()) return null;
          const stored = yield* store.getItem(environmentId).pipe(Effect.mapError(invalidPin));
          if (stored === null) return null;
          const decoded = Base64Url.decode(stored);
          if (
            Result.isFailure(decoded) ||
            decoded.success.length !== 32 ||
            Base64Url.encode(decoded.success) !== stored
          )
            return yield* invalidPin();
          return decoded.success;
        }),
        open: Effect.fn("connectNoise.open")(function* (environmentId, key, mode = "rpc") {
          const bootstrap = yield* relay
            .connectEnvironment({
              clerkToken: yield* cloud.clerkToken,
              scopes: [RelayEnvironmentConnectScope],
              environmentId,
            })
            .pipe(Effect.mapError(mapManagedRelayError));
          if (bootstrap.environmentId !== environmentId)
            return yield* environmentMismatchError({
              expected: environmentId,
              actual: bootstrap.environmentId,
            });

          const reply = yield* options.loadPeer.pipe(
            Effect.flatMap((createPeer) =>
              NoiseApproval.openNoiseRpc(
                {
                  pin: { environmentId, key },
                  credential: bootstrap.credential,
                  wsBaseUrl: bootstrap.endpoint.wsBaseUrl,
                  createPeer,
                },
                mode,
              ),
            ),
            Effect.provideService(ManagedRelay.ManagedRelayDpopSigner, signer),
            Effect.provideService(Socket.WebSocketConstructor, websocket),
            Effect.mapError((error) =>
              error._tag === "NoiseApprovalError"
                ? new ConnectionBlockedError({
                    reason: "authentication",
                    ...translatableDetail(
                      msg(
                        "Check the pairing link and that the host supports encrypted connections.",
                      ),
                    ),
                    hop: "server",
                    via: "relay",
                  })
                : new ConnectionTransientError({
                    reason: "transport",
                    detail: error.message,
                    hop: "tunnel",
                    via: "relay",
                  }),
            ),
          );
          if (reply.status === "pending")
            return yield* new ConnectionTransientError({
              reason: "approval-pending",
              verificationCode: reply.verificationCode,
              approvalMethod: "host-cli",
              ...translatableDetail(msg("This device is waiting for approval on the host.")),
              hop: "server",
              via: "relay",
              failureCause: "approval_pending",
            });
          if (reply.status === "rejected")
            return yield* new ConnectionBlockedError({
              reason: "permission",
              ...translatableDetail(msg("The environment rejected the authentication request.")),
              hop: "server",
              via: "relay",
            });
          return {
            socket: reply.socket,
            authSessionState: {
              authenticated: true,
              auth: reply.auth,
              ...authScopeResponse(reply.scopes),
              expiresAt: reply.expiresAt,
            },
          };
        }),
      });
    }),
  );

  const enroll = Effect.fn("connectNoise.enroll")(
    function* (input: { pin: Pin; replacePin: boolean }) {
      const { environmentId, key } = input.pin;
      const store = yield* options.storage;
      const stored = yield* store.getItem(environmentId);
      const encoded = Base64Url.encode(key);
      if (stored !== null && stored !== encoded && !input.replacePin)
        return { status: "changed" } as const;

      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
      if (entry?.enabled) {
        // Retire any existing ordinary socket before switching this environment's trust policy.
        yield* registry.setEnabled(environmentId, false);
        yield* registry.stateChanges(environmentId).pipe(
          Stream.filter((state) => !state.desired),
          Stream.runHead,
        );
      }
      const saved = yield* store
        .setItem(environmentId, encoded, stored)
        .pipe(
          Effect.onError(() =>
            entry?.enabled
              ? registry.setEnabled(environmentId, true).pipe(Effect.ignore)
              : Effect.void,
          ),
        );
      if (saved === false) {
        if (entry?.enabled) yield* registry.setEnabled(environmentId, true);
        return { status: "changed" } as const;
      }
      const discovery = yield* Discovery.RelayEnvironmentDiscovery;
      const discovered = (yield* SubscriptionRef.get(discovery.state)).environments.get(
        environmentId,
      );
      yield* registry.register(
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({
            environmentId,
            label: entry?.target.label ?? discovered?.environment.label ?? environmentId,
          }),
        }),
      );
      yield* registry.setCompatibility(environmentId, null);
      yield* registry.setEnabled(environmentId, true);
      return { status: "enrolled" } as const;
    },
    Effect.uninterruptible,
    lock.withPermits(1),
  );

  return { layer, enroll };
}

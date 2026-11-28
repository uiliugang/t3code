import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { NoiseConnections } from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as RpcSession from "../rpc/session.ts";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type PreparedConnection,
} from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";

const sshTarget = (connectionId: string) =>
  new SshConnectionTarget({
    environmentId: EnvironmentId.make("environment-1"),
    label: "Test environment",
    connectionId,
  });

const ENTRY: ConnectionCatalogEntry = {
  target: sshTarget("ssh-first"),
  profile: Option.none(),
  enabled: true,
  alternateRoutes: [{ target: sshTarget("ssh-second"), profile: Option.none() }],
};

describe("ConnectionDriver", () => {
  it.effect("does not reach ordinary LAN routes learned through T3 Connect", () =>
    Effect.gen(function* () {
      const environmentId = ENTRY.target.environmentId;
      const relay = new RelayConnectionTarget({ environmentId, label: "Host" });
      const learned = {
        target: new BearerConnectionTarget({ environmentId, label: "LAN", connectionId: "lan" }),
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId: "lan",
            environmentId,
            label: "LAN",
            httpBaseUrl: "http://192.168.0.1:3773",
            wsBaseUrl: "ws://192.168.0.1:3773",
            authorization: "t3-connect",
          }),
        ),
      };
      const error = new ConnectionBlockedError({
        reason: "configuration",
        detail: "Noise required",
      });
      const driver = yield* ConnectionDriver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(NoiseConnections)({
              readPin: () => Effect.succeed(null),
              openRelay: () => Effect.fail(error),
            }),
            Layer.mock(ConnectionResolver.ConnectionResolver)({}),
            Layer.mock(RpcSession.RpcSessionFactory)({}),
            Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({}),
            FetchHttpClient.layer,
          ),
        ),
      );
      const entry = {
        ...learned,
        enabled: true,
        alternateRoutes: [{ target: relay, profile: Option.none() }],
      };
      expect(yield* driver.preflight(entry, learned)).toBe("unchecked");
      expect(yield* driver.connect(entry, () => Effect.void).pipe(Effect.scoped, Effect.flip)).toBe(
        error,
      );
    }),
  );

  it.effect(
    "never prepares ordinary routes or upgrades to LAN when the device pin or handshake fails",
    () =>
      Effect.gen(function* () {
        const route = {
          target: new PrimaryConnectionTarget({
            environmentId: ENTRY.target.environmentId,
            label: "LAN",
            httpBaseUrl: "https://lan.invalid",
            wsBaseUrl: "wss://lan.invalid",
          }),
          profile: Option.none(),
        };
        const error = new ConnectionBlockedError({ reason: "permission", detail: "Denied" });
        for (const readPin of [
          () => Effect.fail(error),
          () => Effect.succeed(new Uint8Array(32)),
        ]) {
          const driver = yield* ConnectionDriver.make.pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(NoiseConnections, { readPin, open: () => Effect.fail(error) }),
                Layer.mock(ConnectionResolver.ConnectionResolver)({}),
                Layer.mock(RpcSession.RpcSessionFactory)({}),
                Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({}),
                FetchHttpClient.layer,
              ),
            ),
          );
          expect(
            yield* driver
              .connect({ ...ENTRY, alternateRoutes: [route] }, () => Effect.void)
              .pipe(Effect.scoped, Effect.flip),
          ).toBe(error);
          expect(yield* driver.preflight(ENTRY, route)).toBe("unchecked");
        }
      }),
  );

  it.effect("reports preparing before each route it prepares", () =>
    Effect.gen(function* () {
      const stages = yield* Ref.make<ReadonlyArray<string>>([]);
      const driver = yield* ConnectionDriver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ConnectionResolver.ConnectionResolver)({
              prepare: (entry) =>
                Effect.succeed({
                  environmentId: entry.target.environmentId,
                  label: entry.target.label,
                  httpBaseUrl: "http://127.0.0.1:1",
                  socketUrl: "ws://127.0.0.1:1/ws",
                  httpAuthorization: null,
                  target: entry.target,
                } satisfies PreparedConnection),
            }),
            Layer.mock(RpcSession.RpcSessionFactory)({
              connect: () =>
                Effect.fail(
                  new ConnectionTransientError({ reason: "transport", detail: "Socket closed." }),
                ),
            }),
            Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({}),
            // SSH routes have no HTTP check, so the driver never sends a request.
            FetchHttpClient.layer,
          ),
        ),
      );

      yield* driver
        .connect(ENTRY, (progress) => Ref.update(stages, (all) => [...all, progress.stage]))
        .pipe(Effect.scoped, Effect.flip);

      expect(yield* Ref.get(stages)).toEqual([
        "preparing",
        "preparing",
        "opening",
        "preparing",
        "opening",
      ]);
    }),
  );

  it.effect("a silent route's network failure does not hide an answered route's refusal", () =>
    Effect.gen(function* () {
      const refused = new ConnectionBlockedError({
        reason: "authentication",
        hop: "server",
        detail: "Session token revoked.",
      });
      const attempted: Array<string> = [];
      const error = yield* ConnectionDriver.connectOverRoutes(
        ENTRY,
        (route) =>
          Effect.succeed<ConnectionDriver.RouteCheck>(
            route.target === ENTRY.target ? "answered" : "silent",
          ),
        (route) => {
          attempted.push(route.target.label);
          return route.target === ENTRY.target
            ? Effect.fail(refused)
            : Effect.fail(
                new ConnectionTransientError({ reason: "transport", detail: "Timed out." }),
              );
        },
      ).pipe(Effect.scoped, Effect.flip);

      // A refusal does not retry, so the silent route still gets its chance to connect.
      expect(attempted).toHaveLength(2);
      expect(error).toBe(refused);
    }),
  );

  describe("publish-only relay", () => {
    const environment = { environmentId: EnvironmentId.make("environment-1"), label: "Host" };
    const relay = {
      target: new RelayConnectionTarget(environment),
      profile: Option.none(),
      failure: new ConnectionBlockedError({
        reason: "permission",
        hop: "tunnel",
        failureCause: "tunnel_not_enabled",
        detail: "The host only publishes activity.",
      }),
    };
    const unlinkedRelay = {
      ...relay,
      failure: new ConnectionBlockedError({
        reason: "permission",
        hop: "relay",
        failureCause: "not_linked",
        detail: "The host is not linked to T3 Connect.",
      }),
    };
    const unreachable = {
      target: new BearerConnectionTarget({ ...environment, connectionId: "unreachable" }),
      profile: Option.none(),
      failure: new ConnectionTransientError({
        reason: "transport",
        detail: "The host is restarting.",
      }),
    };
    const refused = {
      target: new BearerConnectionTarget({ ...environment, connectionId: "refused" }),
      profile: Option.none(),
      failure: new ConnectionBlockedError({
        reason: "authentication",
        hop: "server",
        detail: "Session token revoked.",
      }),
    };

    it.effect.each([
      {
        name: "keeps the refusal when relay is the only route",
        primary: relay,
        alternates: [],
        expected: relay.failure,
      },
      {
        name: "allows retries when a direct route cannot reach the host",
        primary: unreachable,
        alternates: [relay],
        expected: unreachable.failure,
      },
      {
        name: "allows retries when the relay refuses for another reason",
        primary: unreachable,
        alternates: [unlinkedRelay],
        expected: unreachable.failure,
      },
      {
        name: "keeps a direct route's host refusal when a second direct route is unreachable",
        primary: refused,
        alternates: [unreachable, relay],
        expected: refused.failure,
      },
    ])("$name", ({ primary, alternates, expected }) =>
      Effect.gen(function* () {
        const routes = [primary, ...alternates];
        const error = yield* ConnectionDriver.connectOverRoutes(
          {
            target: primary.target,
            profile: primary.profile,
            enabled: true,
            alternateRoutes: alternates,
          },
          (route) =>
            Effect.succeed<ConnectionDriver.RouteCheck>(
              route.target === relay.target ? "unchecked" : "silent",
            ),
          (route) => Effect.fail(routes.find(({ target }) => target === route.target)!.failure),
        ).pipe(Effect.scoped, Effect.flip);

        expect(error).toBe(expected);
      }),
    );

    it.effect("still tries a later silent direct route after the first one fails", () =>
      Effect.gen(function* () {
        const usable = new BearerConnectionTarget({ ...environment, connectionId: "usable" });
        const connection = {
          prepared: { target: usable } as PreparedConnection,
          session: {} as RpcSession.RpcSession,
        };
        const lease = yield* ConnectionDriver.connectOverRoutes(
          {
            target: unreachable.target,
            profile: Option.none(),
            enabled: true,
            alternateRoutes: [{ target: usable, profile: Option.none() }, relay],
          },
          (route) =>
            Effect.succeed<ConnectionDriver.RouteCheck>(
              route.target === relay.target ? "unchecked" : "silent",
            ),
          (route) =>
            route.target === usable
              ? Effect.succeed(connection)
              : Effect.fail(route.target === relay.target ? relay.failure : unreachable.failure),
        ).pipe(Effect.scoped);

        expect(lease.prepared).toBe(connection.prepared);
      }),
    );
  });
});

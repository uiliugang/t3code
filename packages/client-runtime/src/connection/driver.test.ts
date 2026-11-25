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
import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  PrimaryConnectionTarget,
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
});

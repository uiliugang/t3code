// @effect-diagnostics nodeBuiltinImport:off - reads the user guide to check its anchors.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";

import { EnvironmentId, T3_CONNECT_TROUBLESHOOTING_SECTIONS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ConnectReachability from "./ConnectReachability.ts";
import { classifyReachability, type ReachabilityFacts } from "./ConnectReachability.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

vi.mock("node:net", { spy: true });

const checkedAt = "2026-10-19T00:00:00.000Z";
const connected = {
  pid: 1,
  readyConnections: 4,
  hostname: "env.example.test",
  origin: null,
  protocol: "quic",
};
const descriptor = {
  environmentId: EnvironmentId.make("local-environment"),
  label: "Local",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
};
const notConnected = { pid: 1, readyConnections: 0, hostname: null, origin: null, protocol: null };
const facts = (overrides: Partial<ReachabilityFacts>): ReachabilityFacts => ({
  managedTunnelConfigured: true,
  connector: connected,
  endpoint: null,
  originAcceptsTcp: null,
  edgeReachable: null,
  exitNode: null,
  ...overrides,
});

describe("classifyReachability", () => {
  it.each([
    [{ kind: "status", status: 502 }, "unexpected_response"],
    [{ kind: "status", status: 530 }, "unexpected_response"],
    [{ kind: "status", status: 530, cloudflareError: "1033" }, "no_connector"],
    [{ kind: "status", status: 530, cloudflareError: "1016" }, "dns_failed"],
    [{ kind: "status", status: 530, cloudflareError: "1001" }, "unexpected_response"],
    [{ kind: "network_error" }, "timeout"],
  ] as const)("maps endpoint result %o to %s", (endpoint, cause) => {
    expect(classifyReachability(facts({ endpoint, edgeReachable: true }), checkedAt)).toMatchObject(
      { status: "unreachable", cause },
    );
  });

  it("keeps the endpoint cause when the TCP edge test cannot explain it", () => {
    // QUIC (UDP) can connect while TCP 7844 is blocked.
    expect(
      classifyReachability(
        facts({ endpoint: { kind: "status", status: 502 }, edgeReachable: false }),
        checkedAt,
      ),
    ).toMatchObject({ cause: "unexpected_response" });
    expect(
      classifyReachability(
        facts({
          connector: {
            pid: 1,
            readyConnections: null,
            hostname: "env.example.test",
            origin: null,
            protocol: null,
          },
          endpoint: { kind: "status", status: 502 },
          edgeReachable: false,
        }),
        checkedAt,
      ),
    ).toMatchObject({ cause: "unexpected_response" });
    // Failed DNS also fails the edge lookups.
    expect(
      classifyReachability(
        facts({
          connector: {
            pid: 1,
            readyConnections: null,
            hostname: "env.example.test",
            origin: null,
            protocol: null,
          },
          endpoint: { kind: "dns_failed" },
          edgeReachable: false,
        }),
        checkedAt,
      ),
    ).toMatchObject({ cause: "dns_failed" });
  });

  it("waits on a connector that has not connected while the edge answers", () => {
    expect(
      classifyReachability(facts({ connector: notConnected, edgeReachable: true }), checkedAt),
    ).toMatchObject({ cause: "connector_not_ready" });
  });

  it("does not point an unlinked server at a background service it may not have", () => {
    // Desktop and `t3 serve` run the server without a background service.
    const result = classifyReachability(facts({ managedTunnelConfigured: false }), checkedAt);
    expect(result).toMatchObject({ cause: "not_linked" });
    expect(result.status === "unreachable" && result.fix).not.toContain("t3 service");
  });
});

interface ServedResponse {
  readonly status: number;
  readonly body: string | null | ReadableStream<Uint8Array> | { readonly cloudflareError: number };
}

const connectorResponse = (status: number): ServedResponse => ({
  status,
  body: status === 200 ? JSON.stringify(descriptor) : { cloudflareError: 1033 },
});

// What Cloudflare serves for its 530 page: HTML unless the client accepts JSON.
const cloudflareHtmlError = (code: number) =>
  `<h1><span data-translate="error">Error</span>\n<span>${code}</span></h1>`;
const cloudflareErrorPage = (request: HttpClientRequest.HttpClientRequest, code: number) =>
  request.headers.accept === "application/json"
    ? JSON.stringify({ status: 530, error_code: code, error_name: "tunnel_error" })
    : cloudflareHtmlError(code);

type Served = Effect.Effect<ServedResponse, HttpClientError.HttpClientError>;

const reachabilityLayer = (
  respond: Served | ((request: HttpClientRequest.HttpClientRequest) => Served),
  restartConnector: (pid: number, stillDead: Effect.Effect<boolean>) => Effect.Effect<boolean>,
  origin: string | null = null,
) =>
  ConnectReachability.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({
          inspectConnector: Effect.succeed({ ...connected, origin }),
          readinessChanged: Stream.never,
          restartConnector,
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(descriptor.environmentId),
        }),
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: () => Effect.succeedSome(new Uint8Array()),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            (Effect.isEffect(respond) ? respond : respond(request)).pipe(
              Effect.map(({ status, body }) =>
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    body !== null && typeof body === "object" && "cloudflareError" in body
                      ? cloudflareErrorPage(request, body.cloudflareError)
                      : body,
                    { status },
                  ),
                ),
              ),
            ),
          ),
        ),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("no tailscale")),
        ),
      ),
    ),
  );

const mockEdgeConnect = () =>
  vi.spyOn(NodeNet, "connect").mockImplementation(() => {
    const socket = new NodeNet.Socket();
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });

describe("ConnectReachability stale connector recovery", () => {
  it.effect.each([
    {
      name: "an interrupted response",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("connection reset"));
        },
      }),
      cause: "timeout",
    },
    { name: "an empty response", body: null },
    { name: "a proxy login page", body: "<html>Sign in</html>" },
    {
      name: "an incomplete descriptor",
      body: JSON.stringify({ environmentId: descriptor.environmentId }),
    },
    {
      name: "another environment",
      body: JSON.stringify({ ...descriptor, environmentId: "other-environment" }),
    },
    {
      name: "an oversized descriptor",
      body: JSON.stringify({ ...descriptor, label: "x".repeat(256 * 1024) }),
    },
  ])("rejects HTTP 200 from $name", ({ body, cause }) =>
    Effect.gen(function* () {
      using _connect = mockEdgeConnect();
      const result = yield* ConnectReachability.ConnectReachability.use(
        (service) => service.check,
      ).pipe(
        Effect.provide(
          reachabilityLayer(Effect.succeed({ status: 200, body }), () => Effect.succeed(false)),
        ),
      );
      expect(result).toMatchObject({
        status: "unreachable",
        cause: cause ?? "unexpected_response",
      });
    }),
  );

  it.effect("checks the configured loopback port before blaming the origin for a 502", () =>
    Effect.gen(function* () {
      const refused = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      const denied = Object.assign(new Error("socket denied"), { code: "EACCES" });
      for (const [origin, outcome, host, expected] of [
        ["http://127.0.0.1:3773", "connect", "127.0.0.1", "unexpected_response"],
        ["http://[::1]:3773", refused, "::1", "origin_unreachable"],
        ["http://127.0.0.1:3773", denied, "127.0.0.1", "unexpected_response"],
        ["http://127.0.0.1:3773", "timeout", "127.0.0.1", "unexpected_response"],
        [
          "http://localhost:3773",
          Object.assign(new AggregateError([refused, denied]), {
            code: "ECONNREFUSED",
          }),
          "localhost",
          "unexpected_response",
        ],
        [
          "http://localhost:3773",
          new AggregateError([refused, refused]),
          "localhost",
          "origin_unreachable",
        ],
        ["http://elsewhere.test:3773", refused, null, "unexpected_response"],
        [null, refused, null, "unexpected_response"],
      ] as const) {
        using connect = vi.spyOn(NodeNet, "connect").mockImplementation(() => {
          const socket = new NodeNet.Socket();
          queueMicrotask(() => {
            if (outcome instanceof Error) socket.emit("error", outcome);
            else socket.emit(outcome);
          });
          return socket;
        });
        const layer = reachabilityLayer(
          Effect.succeed({ status: 502, body: "Bad Gateway" }),
          () => Effect.succeed(false),
          origin,
        );
        const result = yield* ConnectReachability.ConnectReachability.use(
          (service) => service.check,
        ).pipe(Effect.provide(layer));
        expect(result).toMatchObject({ status: "unreachable", cause: expected });
        if (expected === "unexpected_response" && result.status === "unreachable") {
          expect(result.fix).not.toMatch(/restart/i);
        }
        if (host !== null) {
          expect(connect).toHaveBeenCalledExactlyOnceWith({
            port: 3773,
            host,
          });
        } else {
          expect(connect).not.toHaveBeenCalled();
        }
      }
    }),
  );

  it.effect("restarts cloudflared when Cloudflare has no connector but it reports ready", () =>
    Effect.gen(function* () {
      using _connect = mockEdgeConnect();
      const restarts = yield* Queue.unbounded<number>();
      // Cloudflare answers 530 while cloudflared still reports four ready connections.
      let status = 530;
      let body: ServedResponse["body"] = { cloudflareError: 1033 };
      const layer = reachabilityLayer(
        Effect.sync(() => ({ status, body })),
        (pid, stillDead) =>
          stillDead.pipe(Effect.tap((dead) => (dead ? Queue.offer(restarts, pid) : Effect.void))),
      );
      // The scheduled checks run in the layer's scope, so the assertions run inside it.
      yield* Effect.gen(function* () {
        const reachability = yield* ConnectReachability.ConnectReachability;

        // The first sighting schedules its own confirming check two minutes later.
        expect(yield* reachability.check).toMatchObject({ cause: "no_connector" });
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Queue.size(restarts)).toBe(0);
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Queue.take(restarts)).toBe(connected.pid);

        // A restart that did not help doubles the wait.
        body = cloudflareHtmlError(1033);
        expect(yield* reachability.check).toMatchObject({ cause: "no_connector" });
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Queue.size(restarts)).toBe(0);
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Queue.take(restarts)).toBe(connected.pid);

        // Reaching the endpoint resets the wait, and a 530 for a broken DNS record is left alone.
        status = 200;
        body = JSON.stringify(descriptor);
        expect(yield* reachability.check).toMatchObject({ status: "reachable" });
        status = 530;
        body = cloudflareHtmlError(1016);
        expect(yield* reachability.check).toMatchObject({ cause: "dns_failed" });
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Queue.size(restarts)).toBe(0);

        body = "Unclassified gateway error";
        expect(yield* reachability.check).toMatchObject({ cause: "unexpected_response" });
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Queue.size(restarts)).toBe(0);

        body = "error code: 1033";
        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Queue.take(restarts)).toBe(connected.pid);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("starts a new streak after a healthy check that a newer check overtook", () =>
    Effect.gen(function* () {
      using _connect = mockEdgeConnect();
      const restartTimes = yield* Queue.unbounded<number>();
      const healthyRequested = yield* Deferred.make<void>();
      const healthyAnswer = yield* Deferred.make<void>();
      let status = 530;
      const layer = reachabilityLayer(
        Effect.gen(function* () {
          const served = status;
          if (served === 200) {
            yield* Deferred.succeed(healthyRequested, undefined);
            yield* Deferred.await(healthyAnswer);
          }
          return connectorResponse(served);
        }),
        (_pid, stillDead) =>
          stillDead.pipe(
            Effect.tap((dead) =>
              dead
                ? Clock.currentTimeMillis.pipe(
                    Effect.flatMap((now) => Queue.offer(restartTimes, now)),
                  )
                : Effect.void,
            ),
          ),
      );
      yield* Effect.gen(function* () {
        const reachability = yield* ConnectReachability.ConnectReachability;
        const startedAt = yield* Clock.currentTimeMillis;
        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(1));

        // The healthy answer arrives after a newer check already reported the tunnel dead.
        status = 200;
        const healthy = yield* Effect.forkChild(reachability.check);
        yield* Deferred.await(healthyRequested);
        status = 530;
        yield* reachability.check;
        yield* Deferred.succeed(healthyAnswer, undefined);
        expect(yield* Fiber.join(healthy)).toMatchObject({ status: "reachable" });

        // The grace period starts again at the next dead check, a minute after the first one.
        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(2));
        expect((yield* Queue.take(restartTimes)) - startedAt).toBe(
          Duration.toMillis(Duration.minutes(3)),
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("rejects a restart when an overtaken healthy check finishes while it waits", () =>
    Effect.gen(function* () {
      using _connect = mockEdgeConnect();
      const healthyRequested = yield* Deferred.make<void>();
      const healthyAnswer = yield* Deferred.make<void>();
      const restartRequested = yield* Deferred.make<void>();
      const releaseRestart = yield* Deferred.make<void>();
      const guardChecks = yield* Queue.unbounded<boolean>();
      let status = 530;
      const layer = reachabilityLayer(
        Effect.gen(function* () {
          const served = status;
          if (served === 200) {
            yield* Deferred.succeed(healthyRequested, undefined);
            yield* Deferred.await(healthyAnswer);
          }
          return connectorResponse(served);
        }),
        (_pid, stillDead) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(restartRequested, undefined);
            yield* Deferred.await(releaseRestart);
            const accepted = yield* stillDead;
            yield* Queue.offer(guardChecks, accepted);
            return accepted;
          }),
      );
      yield* Effect.gen(function* () {
        const reachability = yield* ConnectReachability.ConnectReachability;
        yield* reachability.check;
        yield* TestClock.adjust(Duration.seconds(119));

        status = 200;
        const healthy = yield* Effect.forkChild(reachability.check);
        yield* Deferred.await(healthyRequested);
        status = 530;
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Deferred.await(restartRequested);

        yield* Deferred.succeed(healthyAnswer, undefined);
        expect(yield* Fiber.join(healthy)).toMatchObject({ status: "reachable" });
        yield* Deferred.succeed(releaseRestart, undefined);
        expect(yield* Queue.take(guardChecks)).toBe(false);

        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Queue.size(guardChecks)).toBe(0);
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Queue.take(guardChecks)).toBe(true);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("drops the confirming check of a streak that already ended", () =>
    Effect.gen(function* () {
      using _connect = mockEdgeConnect();
      const restarts = yield* Queue.unbounded<number>();
      let status = 530;
      let requests = 0;
      const layer = reachabilityLayer(
        Effect.sync(() => {
          requests += 1;
          return connectorResponse(status);
        }),
        (pid, stillDead) =>
          stillDead.pipe(Effect.tap((dead) => (dead ? Queue.offer(restarts, pid) : Effect.void))),
      );
      yield* Effect.gen(function* () {
        const reachability = yield* ConnectReachability.ConnectReachability;
        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(1));
        status = 200;
        yield* reachability.check;
        status = 530;
        yield* reachability.check;

        const before = requests;
        yield* TestClock.adjust(Duration.minutes(1));
        expect(requests).toBe(before);
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Queue.take(restarts)).toBe(connected.pid);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect.each([
    { status: 200, seconds: 10, cause: "timeout" },
    { status: 530, seconds: 2, cause: "unexpected_response" },
  ])("bounds a stalled HTTP $status body", ({ status, seconds, cause }) =>
    Effect.gen(function* () {
      using _connect = mockEdgeConnect();
      let markBodyRead = () => {};
      const bodyRead = new Promise<void>((resolve) => {
        markBodyRead = resolve;
      });
      const layer = reachabilityLayer(
        Effect.sync(() => ({
          status,
          body: new ReadableStream({
            pull: () => {
              markBodyRead();
              return new Promise<void>(() => {});
            },
          }),
        })),
        () => Effect.succeed(false),
      );
      yield* Effect.gen(function* () {
        const reachability = yield* ConnectReachability.ConnectReachability;
        const check = yield* Effect.forkChild(reachability.check);
        yield* Effect.promise(() => bodyRead);
        yield* TestClock.adjust(Duration.seconds(seconds));
        expect(yield* Fiber.join(check)).toMatchObject({ cause });
      }).pipe(Effect.provide(layer));
    }),
  );
});

describe("ConnectReachability DNS failures", () => {
  // undici wraps getaddrinfo's error in `TypeError: fetch failed`. glibc behind
  // systemd-resolved can report an NXDOMAIN as EBUSY rather than ENOTFOUND.
  const lookupFailed = (code: string) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request: HttpClientRequest.get("https://env.example.test"),
          cause: new TypeError("fetch failed", {
            cause: Object.assign(new Error(`getaddrinfo ${code} env.example.test`), {
              code,
              syscall: "getaddrinfo",
              hostname: "env.example.test",
            }),
          }),
        }),
      }),
    );

  it.effect("reports a getaddrinfo EBUSY as a DNS failure", () =>
    Effect.gen(function* () {
      using _connect = mockEdgeConnect();
      const layer = reachabilityLayer(lookupFailed("EBUSY"), () => Effect.succeed(false));
      const result = yield* ConnectReachability.ConnectReachability.use(
        (reachability) => reachability.check,
      ).pipe(Effect.provide(layer));
      expect(result).toMatchObject({ status: "unreachable", cause: "dns_failed" });
    }),
  );

  // A local "not found" cached before the relay published the record looks like a missing
  // record. Public DNS tells them apart.
  it.effect("says whether the name exists in public DNS", () =>
    Effect.gen(function* () {
      using _connect = mockEdgeConnect();
      for (const [lookupCode, dnsStatus, reason] of [
        ["ENOTFOUND", 0, "old cached answer"],
        ["ENOTFOUND", 3, "missing from public DNS"],
        // The local resolver did not answer, so nothing it cached is to blame.
        ["EAI_AGAIN", 0, "does not resolve from this machine"],
      ] as const) {
        const layer = reachabilityLayer(
          (request) =>
            request.url.startsWith("https://1.1.1.1/dns-query")
              ? Effect.succeed({ status: 200, body: JSON.stringify({ Status: dnsStatus }) })
              : lookupFailed(lookupCode),
          () => Effect.succeed(false),
        );
        const result = yield* ConnectReachability.ConnectReachability.use(
          (reachability) => reachability.check,
        ).pipe(Effect.provide(layer));
        expect(result).toMatchObject({
          cause: "dns_failed",
          reason: expect.stringContaining(reason),
        });
      }
    }),
  );
});

describe("T3 Connect troubleshooting links", () => {
  it("each section names a heading in the user guide", () => {
    const guide = NodeFS.readFileSync(
      new URL("../../../../docs/user/t3-connect-troubleshooting.md", import.meta.url),
      "utf8",
    );
    // GitHub's heading anchors: lowercase, drop punctuation, spaces become hyphens.
    const anchors = new Set(
      [...guide.matchAll(/^#{2,3} (.+)$/gm)].map(([, heading]) =>
        heading!
          .toLowerCase()
          .replace(/[^\p{L}\p{N} _-]/gu, "")
          .replace(/ /g, "-"),
      ),
    );
    for (const section of T3_CONNECT_TROUBLESHOOTING_SECTIONS) {
      expect(anchors, section).toContain(section);
    }
  });
});

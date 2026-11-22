import {
  AuthStandardClientScopes,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import {
  type RelayEnvironmentConnectResponse,
  RelayEnvironmentEndpointTimedOutError,
  RelayEnvironmentEndpointUnavailableError,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ManagedRelay from "../relay/managedRelay.ts";
import { mintMediaTicket } from "../state/deviceHubAccess.ts";
import { fetchEnvironmentSessionState } from "../state/session.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "./service.ts";
import * as TokenStore from "./tokenStore.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCredential,
  DpopConnectionCredential,
} from "../connection/catalog.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  ConnectionTransientError,
} from "../connection/model.ts";
import * as ConnectionProfileStore from "../connection/profileStore.ts";
import * as ConnectionResolver from "../connection/resolver.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
  providerKind: "cloudflare_tunnel" as const,
};
const DESCRIPTOR = {
  environmentId: ENVIRONMENT_ID,
  label: "Remote environment",
  platform: {
    os: "linux",
    arch: "x64",
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};
const BOOTSTRAP: RelayEnvironmentConnectResponse = {
  environmentId: ENVIRONMENT_ID,
  endpoint: ENDPOINT,
  credential: "relay-bootstrap",
  expiresAt: "2026-06-06T01:00:00.000Z",
};

type RecordedResponse = Response | ((init: RequestInit) => Response | Promise<Response>);

type DescriptorFixture = typeof DESCRIPTOR | (() => Response | Promise<Response>);

function recordedFetch(responses: ReadonlyArray<RecordedResponse>, descriptor?: DescriptorFixture) {
  const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
  let responseIndex = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    if (descriptor !== undefined && String(input).endsWith("/.well-known/t3/environment")) {
      return Promise.resolve(
        typeof descriptor === "function" ? descriptor() : Response.json(descriptor),
      );
    }
    const response = responses[responseIndex++];
    return response === undefined
      ? Promise.reject(new Error(`Unexpected fetch call to ${String(input)}`))
      : Promise.resolve(typeof response === "function" ? response(init ?? {}) : response);
  }) satisfies typeof fetch;
  return { calls, fetchFn };
}

const websocketTicket = (ticket: string) =>
  Response.json({
    ticket,
    expiresAt: "2026-06-06T01:00:00.000Z",
  });

const accessToken = (token: string, scope = AuthStandardClientScopes.join(" ")) =>
  Response.json({
    access_token: token,
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    token_type: "DPoP",
    expires_in: 3_600,
    scope,
  });

const authInvalid = () =>
  Response.json(
    {
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-auth-invalid",
    },
    { status: 401 },
  );

const persistedToken = (
  input: {
    readonly environmentId?: EnvironmentId;
    readonly accessToken?: string;
    readonly expiresAtEpochMs?: number;
    readonly dpopThumbprint?: string;
  } = {},
) =>
  new TokenStore.RemoteDpopAccessToken({
    environmentId: input.environmentId ?? ENVIRONMENT_ID,
    accountId: "account-1",
    label: DESCRIPTOR.label,
    endpoint: ENDPOINT,
    accessToken: input.accessToken ?? "cached-access-token",
    expiresAtEpochMs: input.expiresAtEpochMs ?? Number.MAX_SAFE_INTEGER,
    dpopThumbprint: input.dpopThumbprint ?? "thumbprint-1",
  });

const requireOnlineRelay = (online: Ref.Ref<boolean>) =>
  Ref.get(online).pipe(
    Effect.filterOrFail(
      (available) => available,
      () =>
        new ManagedRelay.ManagedRelayRequestFailedError({
          action: "connect relay environment",
          cause: "offline",
          transportFailed: true,
        }),
    ),
    Effect.asVoid,
  );

const makeHarness = Effect.fn("TestRemoteAuthorization.makeHarness")(function* (input: {
  readonly initialToken?: TokenStore.RemoteDpopAccessToken;
  readonly responses: ReadonlyArray<RecordedResponse>;
  /** Answers every descriptor read, so one that runs beside a ticket does not shift `responses`. */
  readonly descriptor?: DescriptorFixture;
  readonly bootstrap?: RelayEnvironmentConnectResponse;
  readonly beforeBootstrap?: Effect.Effect<void, ManagedRelay.ManagedRelayClientError>;
  readonly beforePut?: Effect.Effect<void>;
  readonly clerkToken?: ClientCapabilities.CloudSession["Service"]["clerkToken"];
  readonly credentials?: ReadonlyArray<readonly [string, ConnectionCredential]>;
}) {
  const tokens = yield* Ref.make(
    new Map(
      input.initialToken === undefined
        ? []
        : [[input.initialToken.environmentId, input.initialToken]],
    ),
  );
  const bootstrapCalls = yield* Ref.make(0);
  const relayInputs = yield* Ref.make<
    ReadonlyArray<Parameters<ManagedRelay.ManagedRelayClient["Service"]["connectEnvironment"]>[0]>
  >([]);
  const session = yield* Ref.make<Option.Option<ClientCapabilities.CloudSessionIdentity>>(
    Option.some({ accountId: "account-1" }),
  );
  const thumbprint = yield* Ref.make("thumbprint-1");
  const tokenReads = yield* Queue.unbounded<EnvironmentId>();
  const proofInputs = yield* Ref.make<
    ReadonlyArray<{
      readonly method: string;
      readonly url: string;
      readonly accessToken?: string;
    }>
  >([]);
  const fetch = recordedFetch(input.responses, input.descriptor);

  const tokenStore = TokenStore.RemoteDpopAccessTokenStore.of({
    get: (environmentId) =>
      Ref.get(tokens).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(environmentId))),
        Effect.tap(() => Queue.offer(tokenReads, environmentId)),
      ),
    put: (token, ifCurrentAccessToken) =>
      (input.beforePut ?? Effect.void).pipe(
        Effect.andThen(
          Ref.update(tokens, (current) => {
            if (
              ifCurrentAccessToken !== undefined &&
              current.get(token.environmentId)?.accessToken !== ifCurrentAccessToken
            )
              return current;
            const next = new Map(current);
            next.set(token.environmentId, token);
            return next;
          }),
        ),
      ),
    remove: (environmentId) =>
      Ref.update(tokens, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      }),
  });
  const signer = ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Ref.get(thumbprint),
    createProof: (proofInput) =>
      Ref.update(proofInputs, (current) => [...current, proofInput]).pipe(
        Effect.as(`proof:${proofInput.url}`),
      ),
  });
  const unexpected = () => Effect.die("Unexpected relay request");
  const relay = ManagedRelay.ManagedRelayClient.of({
    relayUrl: "https://relay.example.test",
    listEnvironments: unexpected,
    listDevices: unexpected,
    createEnvironmentLinkChallenge: unexpected,
    linkEnvironment: unexpected,
    unlinkEnvironment: unexpected,
    getT3ChatLink: unexpected,
    createT3ChatLinkRequest: unexpected,
    unlinkT3Chat: unexpected,
    getEnvironmentStatus: unexpected,
    connectEnvironment: (request) =>
      Effect.gen(function* () {
        yield* Ref.update(bootstrapCalls, (count) => count + 1);
        yield* Ref.update(relayInputs, (current) => [...current, request]);
        yield* input.beforeBootstrap ?? Effect.void;
        return input.bootstrap ?? BOOTSTRAP;
      }),
    registerDevice: unexpected,
    unregisterDevice: unexpected,
    registerLiveActivity: unexpected,
    getAgentActivitySnapshot: unexpected,
    resetTokenCache: Effect.void,
  });
  const layer = RemoteEnvironmentAuthorization.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        RpcHttp.layerRemoteHttpClient(fetch.fetchFn),
        Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, signer),
        Layer.succeed(ManagedRelay.ManagedRelayClient, relay),
        Layer.succeed(ClientCapabilities.CloudSession, {
          identity: Ref.get(session),
          clerkToken: input.clerkToken ?? Effect.succeed("clerk-session"),
        }),
        Layer.succeed(ClientCapabilities.RelayDeviceIdentity, {
          deviceId: Effect.succeedSome("device-1"),
        }),
        Layer.succeed(TokenStore.RemoteDpopAccessTokenStore, tokenStore),
        ConnectionCredentialStore.layerMemory(input.credentials),
        Layer.succeed(
          ClientCapabilities.ClientPresentation,
          ClientCapabilities.ClientPresentation.of({
            metadata: {
              label: "T3 Code Test",
              deviceType: "mobile",
              os: "test",
            },
          }),
        ),
      ),
    ),
  );
  return {
    layer,
    tokens,
    bootstrapCalls,
    proofInputs,
    fetch,
    relayInputs,
    session,
    thumbprint,
    tokenReads,
  };
});

const requestsTo = (harness: Effect.Success<ReturnType<typeof makeHarness>>, path: string) =>
  harness.fetch.calls.filter(([url]) => String(url).endsWith(path)).length;

const prepareDirectBearer = Effect.fn("TestRemoteAuthorization.prepareDirectBearer")(function* (
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  times: number,
) {
  const target = new BearerConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: DESCRIPTOR.label,
    connectionId: "direct-1",
  });
  const entry = {
    target,
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: target.connectionId,
        environmentId: ENVIRONMENT_ID,
        label: target.label,
        httpBaseUrl: ENDPOINT.httpBaseUrl,
        wsBaseUrl: ENDPOINT.wsBaseUrl,
      }),
    ),
    enabled: true,
  };
  const unused = () => Effect.die("unused");
  const layer = ConnectionResolver.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        harness.layer,
        Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, {
          get: unused,
          put: unused,
          remove: unused,
        }),
        Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, {
          get: () => Effect.succeedSome(new BearerConnectionCredential({ token: "bearer-token" })),
          put: unused,
          remove: unused,
        }),
        Layer.succeed(ClientCapabilities.PrimaryEnvironmentAuth, {
          bearerToken: Effect.succeedNone,
        }),
        Layer.succeed(ClientCapabilities.SshEnvironmentGateway, {
          provision: unused,
          prepare: unused,
          disconnect: unused,
        }),
      ),
    ),
  );
  const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layer));
  return yield* Effect.forEach(Array.from({ length: times }), () =>
    resolver.prepare(entry).pipe(Effect.result),
  );
});

describe("RemoteEnvironmentAuthorization", () => {
  it.effect("prepares a cold direct bearer connection with one descriptor request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json({
            ...DESCRIPTOR,
            orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          }),
          websocketTicket("cold-ticket"),
        ],
      });

      const [prepared] = yield* prepareDirectBearer(harness, 1);

      expect(prepared).toMatchObject({
        _tag: "Success",
        success: { socketUrl: expect.stringContaining("wsTicket=cold-ticket") },
      });
      expect(harness.fetch.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        "/.well-known/t3/environment",
        "/api/auth/websocket-ticket/rpc",
      ]);
    }),
  );

  it.effect("renews an expired direct DPoP token with the host and keeps the renewal", () =>
    Effect.gen(function* () {
      const renewal = (init: RequestInit) => {
        const fields = new URLSearchParams(
          init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init.body),
        );
        expect(fields.get("subject_token")).toBe("expired-direct-token");
        expect(fields.get("subject_token_type")).toBe(
          "urn:ietf:params:oauth:token-type:access_token",
        );
        return accessToken("renewed-direct-token");
      };
      const harness = yield* makeHarness({
        responses: [renewal, websocketTicket("direct-ticket")],
        descriptor: DESCRIPTOR,
        credentials: [
          [
            "direct-1",
            new DpopConnectionCredential({
              accessToken: "expired-direct-token",
              expiresAtEpochMs: 0,
            }),
          ],
        ],
      });

      const [authorized, stored] = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
        const authorized = yield* remote.authorizeDirectDpop({
          expectedEnvironmentId: ENVIRONMENT_ID,
          connectionId: "direct-1",
          httpBaseUrl: ENDPOINT.httpBaseUrl,
          wsBaseUrl: ENDPOINT.wsBaseUrl,
        });
        return [authorized, yield* credentials.get("direct-1")] as const;
      }).pipe(Effect.provide(harness.layer));

      expect(authorized.socketUrl).toContain("wsTicket=direct-ticket");
      expect(authorized.httpAuthorization).toMatchObject({
        _tag: "Dpop",
        accessToken: "renewed-direct-token",
        directConnection: { connectionId: "direct-1", httpBaseUrl: ENDPOINT.httpBaseUrl },
      });
      expect(Option.getOrThrow(stored)).toMatchObject({
        _tag: "DpopConnectionCredential",
        accessToken: "renewed-direct-token",
      });
      expect((yield* Ref.get(harness.proofInputs)).map((proof) => proof.url)).toEqual([
        `${ENDPOINT.httpBaseUrl}/oauth/token`,
        `${ENDPOINT.httpBaseUrl}/api/auth/websocket-ticket/rpc`,
        `${ENDPOINT.httpBaseUrl}/ws`,
      ]);
    }),
  );

  it.effect("renews another direct host while the first host is unresponsive", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<Response>();
      const first = { connectionId: "direct-1", httpBaseUrl: ENDPOINT.httpBaseUrl };
      const second = { connectionId: "direct-2", httpBaseUrl: "https://other.example.test" };
      const harness = yield* makeHarness({
        responses: [
          () => {
            started.resolve();
            return release.promise;
          },
          () => accessToken("renewed-second-token"),
        ],
        credentials: [first, second].map(({ connectionId }) => [
          connectionId,
          new DpopConnectionCredential({ accessToken: connectionId, expiresAtEpochMs: 0 }),
        ]),
      });

      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const pending = yield* remote.authorizeDirectDpopHttp(first).pipe(Effect.forkScoped);
        yield* Effect.promise(() => started.promise);
        const healthy = yield* remote
          .authorizeDirectDpopHttp(second)
          .pipe(Effect.timeoutOption("1 second"), Effect.forkScoped);
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(healthy)).toMatchObject({
          _tag: "Some",
          value: { accessToken: "renewed-second-token" },
        });
        release.resolve(accessToken("renewed-first-token"));
        expect((yield* Fiber.join(pending)).accessToken).toBe("renewed-first-token");
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
    }),
  );

  it.effect("reuses a matching descriptor a check just read, once, while fresh", () =>
    Effect.gen(function* () {
      const descriptor = {
        ...DESCRIPTOR,
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
      } as ExecutionEnvironmentDescriptor;
      const harness = yield* makeHarness({
        responses: [
          websocketTicket("reused"),
          ...Array.from({ length: 4 }, () => [
            Response.json(descriptor),
            websocketTicket("fresh"),
          ]).flat(),
          websocketTicket("reused over plain HTTP"),
          Response.json(descriptor),
          websocketTicket("fresh"),
        ],
      });

      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorizeAt = (httpBaseUrl: string) =>
          remote.authorizeBearer({
            expectedEnvironmentId: ENVIRONMENT_ID,
            httpBaseUrl,
            wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
            bearerToken: "bearer-token",
            connectionMethod: "direct",
          });
        const authorize = authorizeAt(ENDPOINT.httpBaseUrl);
        const remember = (value: Option.Option<ExecutionEnvironmentDescriptor>) =>
          remote.rememberCheckedDescriptor(ENDPOINT.httpBaseUrl, value, true);

        yield* remember(Option.some(descriptor));
        yield* authorize;
        // Used once.
        yield* authorize;
        // Stale.
        yield* remember(Option.some(descriptor));
        yield* TestClock.adjust("6 seconds");
        yield* authorize;
        // A mismatch reads again, so a host back on the right environment is not blocked.
        yield* remember(Option.some({ ...descriptor, environmentId: "other" as never }));
        yield* authorize;
        // A failed check drops an older match.
        yield* remember(Option.some(descriptor));
        yield* remember(Option.none());
        yield* authorize;
        // Plain HTTP is no reason to read again where the address keeps its host.
        yield* remote.rememberCheckedDescriptor(
          "http://127.0.0.1:3773",
          Option.some(descriptor),
          true,
        );
        yield* authorizeAt("http://127.0.0.1:3773");
        // After a network change, a plain LAN address can belong to another machine.
        yield* remote.rememberCheckedDescriptor(
          "http://192.168.1.2:3773",
          Option.some(descriptor),
          false,
        );
        yield* authorizeAt("http://192.168.1.2:3773");
      }).pipe(Effect.provide(harness.layer));

      expect(harness.fetch.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        "/api/auth/websocket-ticket/rpc",
        ...Array.from({ length: 4 }, () => [
          "/.well-known/t3/environment",
          "/api/auth/websocket-ticket/rpc",
        ]).flat(),
        "/api/auth/websocket-ticket/rpc",
        "/.well-known/t3/environment",
        "/api/auth/websocket-ticket/rpc",
      ]);
    }),
  );

  it.effect("blocks a warm direct bearer prepare when the environment changes identity", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json({
            ...DESCRIPTOR,
            orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          }),
          websocketTicket("first-ticket"),
          Response.json({
            ...DESCRIPTOR,
            environmentId: "another-environment",
            orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          }),
        ],
      });

      const [first, second] = yield* prepareDirectBearer(harness, 2);

      expect(first?._tag).toBe("Success");
      expect(second).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionBlockedError", reason: "configuration" },
      });
      expect(
        harness.fetch.calls.filter(([url]) =>
          String(url).endsWith("/api/auth/websocket-ticket/rpc"),
        ),
      ).toHaveLength(1);
    }),
  );
  it.effect("validates a fresh bearer descriptor while issuing fresh websocket tickets", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json(DESCRIPTOR),
          websocketTicket("first-ticket"),
          Response.json(DESCRIPTOR),
          websocketTicket("second-ticket"),
        ],
      });

      const [first, second] = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorize = () =>
          remote.authorizeBearer({
            expectedEnvironmentId: ENVIRONMENT_ID,
            httpBaseUrl: ENDPOINT.httpBaseUrl,
            wsBaseUrl: ENDPOINT.wsBaseUrl,
            bearerToken: "bearer-token",
            connectionMethod: "direct",
          });
        return [yield* authorize(), yield* authorize()] as const;
      }).pipe(Effect.provide(harness.layer));

      expect(first.socketUrl).toContain("wsTicket=first-ticket");
      expect(second.socketUrl).toContain("wsTicket=second-ticket");
      expect(
        harness.fetch.calls.filter(([url]) => String(url).endsWith("/.well-known/t3/environment")),
      ).toHaveLength(2);
      expect(
        harness.fetch.calls.filter(([url]) =>
          String(url).endsWith("/api/auth/websocket-ticket/rpc"),
        ),
      ).toHaveLength(2);
    }),
  );

  it.effect("gives up on a silent loopback or LAN address sooner than on a remote one", () =>
    Effect.gen(function* () {
      const silent = () => new Promise<Response>(() => {});
      const harness = yield* makeHarness({ responses: [silent, silent, silent] });

      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorizeAt = (httpBaseUrl: string, connectionMethod: "direct" | "ssh" = "direct") =>
          remote
            .authorizeBearer({
              expectedEnvironmentId: ENVIRONMENT_ID,
              httpBaseUrl,
              wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
              bearerToken: "bearer-token",
              connectionMethod,
            })
            .pipe(Effect.flip, Effect.forkChild);
        const lan = yield* authorizeAt("http://192.168.1.2:3773");
        const tailnet = yield* authorizeAt("http://100.101.102.103:3773");
        // An SSH forward listens on loopback but reaches a remote host.
        const forwarded = yield* authorizeAt("http://127.0.0.1:4010", "ssh");

        yield* TestClock.adjust("3 seconds");
        expect(lan.pollUnsafe()).toBeDefined();
        expect(tailnet.pollUnsafe()).toBeUndefined();
        expect(forwarded.pollUnsafe()).toBeUndefined();
        expect(yield* Fiber.join(lan)).toMatchObject({
          _tag: "ConnectionTransientError",
          reason: "timeout",
        });

        yield* TestClock.adjust("7 seconds");
        expect(tailnet.pollUnsafe()).toBeDefined();
        expect(forwarded.pollUnsafe()).toBeDefined();
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("reuses a same-account persisted environment token without contacting the relay", () =>
    Effect.gen(function* () {
      const cached = new TokenStore.RemoteDpopAccessToken({
        environmentId: ENVIRONMENT_ID,
        accountId: "account-1",
        label: DESCRIPTOR.label,
        endpoint: ENDPOINT,
        accessToken: "cached-access-token",
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        dpopThumbprint: "thumbprint-1",
      });
      const harness = yield* makeHarness({
        initialToken: cached,
        descriptor: DESCRIPTOR,
        responses: [websocketTicket("cached-ticket")],
      });

      const authorized = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpop({
          expectedEnvironmentId: ENVIRONMENT_ID,
        });
      }).pipe(Effect.provide(harness.layer));

      expect(authorized.socketUrl).toContain("wsTicket=cached-ticket");
      expect(authorized.socketUrl).toContain("connectionMethod=relay");
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(0);
      // The descriptor is read beside the ticket, so the connect needs no later read.
      expect(authorized.descriptor).toMatchObject({ environmentId: ENVIRONMENT_ID });
      expect(harness.fetch.calls.map(([url]) => String(url)).toSorted()).toEqual([
        "https://environment.example.test/.well-known/t3/environment",
        "https://environment.example.test/api/auth/websocket-ticket/rpc",
      ]);
    }),
  );

  it.effect("uses the T3 Connect token on a learned direct address without the relay", () =>
    Effect.gen(function* () {
      const cached = new TokenStore.RemoteDpopAccessToken({
        environmentId: ENVIRONMENT_ID,
        accountId: "account-1",
        label: DESCRIPTOR.label,
        endpoint: ENDPOINT,
        accessToken: "cached-access-token",
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        dpopThumbprint: "thumbprint-1",
      });
      const harness = yield* makeHarness({
        initialToken: cached,
        responses: [Response.json(DESCRIPTOR), websocketTicket("lan-ticket")],
      });

      const authorized = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpop({
          expectedEnvironmentId: ENVIRONMENT_ID,
          directEndpoint: {
            httpBaseUrl: "http://192.168.1.10:3773/",
            wsBaseUrl: "ws://192.168.1.10:3773/",
          },
        });
      }).pipe(Effect.provide(harness.layer));

      expect(authorized.httpBaseUrl).toBe("http://192.168.1.10:3773/");
      expect(authorized.socketUrl).toMatch(/^ws:\/\/192\.168\.1\.10:3773\/ws\?/);
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(0);
      expect(harness.fetch.calls.map(([url]) => String(url))).toEqual([
        "http://192.168.1.10:3773/.well-known/t3/environment",
        "http://192.168.1.10:3773/api/auth/websocket-ticket/rpc",
      ]);
    }),
  );

  it.effect("sends no token to a direct address that answers as another machine", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialToken: persistedToken({ accessToken: "cached-access-token" }),
        responses: [
          Response.json({ ...DESCRIPTOR, environmentId: EnvironmentId.make("someone-else") }),
        ],
      });

      const error = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote
          .authorizeDpop({
            expectedEnvironmentId: ENVIRONMENT_ID,
            directEndpoint: {
              httpBaseUrl: "http://192.168.1.10:3773/",
              wsBaseUrl: "ws://192.168.1.10:3773/",
            },
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(harness.layer));

      expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
      expect(harness.fetch.calls.map(([url]) => String(url))).toEqual([
        "http://192.168.1.10:3773/.well-known/t3/environment",
      ]);
      expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)?.accessToken).toBe(
        "cached-access-token",
      );
    }),
  );

  it.effect("refreshes and persists an expired environment token", () =>
    Effect.gen(function* () {
      const expired = new TokenStore.RemoteDpopAccessToken({
        environmentId: ENVIRONMENT_ID,
        accountId: "account-1",
        label: DESCRIPTOR.label,
        endpoint: ENDPOINT,
        accessToken: "expired-access-token",
        expiresAtEpochMs: 0,
        dpopThumbprint: "thumbprint-1",
      });
      const harness = yield* makeHarness({
        initialToken: expired,
        responses: [
          Response.json(DESCRIPTOR),
          accessToken("fresh-access-token"),
          websocketTicket("fresh-ticket"),
        ],
      });

      const authorized = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpop({
          expectedEnvironmentId: ENVIRONMENT_ID,
        });
      }).pipe(Effect.provide(harness.layer));

      expect(authorized.socketUrl).toContain("wsTicket=fresh-ticket");
      // The mint already read the descriptor.
      expect(authorized.descriptor).toMatchObject({ environmentId: ENVIRONMENT_ID });
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)).toEqual(
        expect.objectContaining({
          accessToken: "fresh-access-token",
          dpopThumbprint: "thumbprint-1",
        }),
      );
      expect(harness.fetch.calls).toHaveLength(3);
    }),
  );

  it.effect.each([
    { name: "read-only", grantScopes: ["orchestration:read"] },
    { name: "default", grantScopes: AuthStandardClientScopes },
  ] as const)(
    "inherits $name pairing grant scopes for websocket authorization and HTTP renewal",
    ({ grantScopes }) =>
      Effect.gen(function* () {
        const grantedScope = grantScopes.join(" ");
        let exchangeCount = 0;
        const tokenFields = (init: RequestInit) =>
          new URLSearchParams(
            init.body instanceof Uint8Array
              ? new TextDecoder().decode(init.body)
              : String(init.body),
          );
        const exchangeGrant = (init: RequestInit) => {
          const fields = tokenFields(init);
          expect(fields.get("scope")).toBeNull();
          const scope = fields.get("scope") ?? grantedScope;
          const scopes = scope.split(" ");
          if (scopes.some((requested) => !grantScopes.some((grant) => grant === requested))) {
            return authInvalid();
          }
          return accessToken(`access-token:${++exchangeCount}:${scopes.join(",")}`, scope);
        };
        const harness = yield* makeHarness({
          responses: [
            Response.json(DESCRIPTOR),
            exchangeGrant,
            websocketTicket("granted-ticket"),
            Response.json(DESCRIPTOR),
            exchangeGrant,
          ],
        });

        const [authorized, refreshed] = yield* Effect.gen(function* () {
          const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
          const first = yield* remote.authorizeDpop({
            expectedEnvironmentId: ENVIRONMENT_ID,
          });
          yield* TestClock.adjust("1 hour");
          const refreshed = yield* remote.authorizeDpopHttp({
            expectedEnvironmentId: ENVIRONMENT_ID,
          });
          return [first, refreshed] as const;
        }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));

        expect(authorized.socketUrl).toContain("wsTicket=granted-ticket");
        expect(authorized.httpAuthorization).toMatchObject({
          _tag: "Dpop",
          accessToken: `access-token:1:${grantScopes.join(",")}`,
        });
        expect(refreshed.httpAuthorization).toMatchObject({
          _tag: "Dpop",
          accessToken: `access-token:2:${grantScopes.join(",")}`,
        });
        expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)).toMatchObject({
          accessToken: `access-token:2:${grantScopes.join(",")}`,
          dpopThumbprint: "thumbprint-1",
        });
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(2);
        const exchanges = harness.fetch.calls.filter(([url]) =>
          String(url).endsWith("/oauth/token"),
        );
        expect(exchanges).toHaveLength(2);
        for (const [, init] of exchanges) {
          expect(Object.fromEntries(tokenFields(init))).toMatchObject({
            subject_token: BOOTSTRAP.credential,
            client_label: "T3 Code Test",
            client_device_type: "mobile",
            client_os: "test",
          });
        }
      }),
  );

  it.effect("renews a live socket's token in the minute before each expiry", () =>
    Effect.gen(function* () {
      const puts = yield* Queue.unbounded<void>();
      const relayBlips = yield* Ref.make(1);
      const harness = yield* makeHarness({
        beforeBootstrap: Ref.getAndUpdate(relayBlips, (count) => count - 1).pipe(
          Effect.flatMap((count) =>
            count > 0
              ? Effect.fail(
                  new ManagedRelay.ManagedRelayRequestTimeoutError({
                    activity: "Relay environment connection",
                    timeoutMs: 30_000,
                    traceId: null,
                  }),
                )
              : Effect.void,
          ),
        ),
        initialToken: persistedToken({ expiresAtEpochMs: 3_600_000 }),
        responses: [
          Response.json(DESCRIPTOR),
          accessToken("renewed-1"),
          Response.json(DESCRIPTOR),
          accessToken("renewed-2"),
        ],
        beforePut: Queue.offer(puts, undefined).pipe(Effect.asVoid),
      });

      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        yield* remote
          .renewDpopBeforeExpiry({
            expectedEnvironmentId: ENVIRONMENT_ID,
            expiresAtEpochMs: 3_600_000,
          })
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust(3_540_000 - 1);
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(0);
        // The first try hits a relay blip, and the retry 5 s later succeeds.
        yield* TestClock.adjust(1);
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
        yield* TestClock.adjust(5_000);
        yield* Queue.take(puts);
        // Renewed at 0:59:05, so the next renewal is at 1:58:05.
        yield* TestClock.adjust(7_085_000 - 3_545_000 - 1);
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(2);
        yield* TestClock.adjust(1);
        yield* Queue.take(puts);
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(3);
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(harness.layer, TestClock.layer())));
    }),
  );

  it.effect("keeps renewing a direct socket after a failed renewal past token expiry", () =>
    Effect.gen(function* () {
      let markLoopRenewal = () => {};
      const loopRenewed = new Promise<void>((resolve) => (markLoopRenewal = resolve));
      const connection = { connectionId: "direct-1", httpBaseUrl: ENDPOINT.httpBaseUrl };
      const harness = yield* makeHarness({
        responses: [
          () => Promise.reject(new TypeError("network down")),
          () => {
            markLoopRenewal();
            return accessToken("renewed-direct-token");
          },
        ],
        credentials: [
          [
            "direct-1",
            new DpopConnectionCredential({ accessToken: "direct-token", expiresAtEpochMs: 1_000 }),
          ],
        ],
      });

      const renewed = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        yield* remote
          .renewDpopBeforeExpiry({
            expectedEnvironmentId: ENVIRONMENT_ID,
            expiresAtEpochMs: 1_000,
            directConnection: connection,
          })
          .pipe(Effect.forkScoped);
        // The first try, at 5 s, is already past the token's expiry and fails.
        yield* TestClock.adjust(5_000);
        // The host keeps a direct socket for its session's window, so the loop tries again.
        yield* TestClock.adjust(60_000);
        yield* Effect.promise(() => loopRenewed);
        // Waits behind the loop's renewal and reads what it stored, with no request of its own.
        return yield* remote.authorizeDirectDpopHttp(connection);
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(harness.layer, TestClock.layer())));

      expect(renewed.accessToken).toBe("renewed-direct-token");
    }),
  );

  it.effect("evicts an auth-invalid cached token and obtains a fresh bootstrap", () =>
    Effect.gen(function* () {
      const cached = new TokenStore.RemoteDpopAccessToken({
        environmentId: ENVIRONMENT_ID,
        accountId: "account-1",
        label: DESCRIPTOR.label,
        endpoint: ENDPOINT,
        accessToken: "invalid-access-token",
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        dpopThumbprint: "thumbprint-1",
      });
      const harness = yield* makeHarness({
        initialToken: cached,
        descriptor: DESCRIPTOR,
        responses: [
          authInvalid(),
          accessToken("replacement-access-token"),
          websocketTicket("replacement-ticket"),
        ],
      });

      const authorized = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpop({
          expectedEnvironmentId: ENVIRONMENT_ID,
        });
      }).pipe(Effect.provide(harness.layer));

      expect(authorized.socketUrl).toContain("wsTicket=replacement-ticket");
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)).toEqual(
        expect.objectContaining({
          accessToken: "replacement-access-token",
        }),
      );
      expect(requestsTo(harness, "/api/auth/websocket-ticket/rpc")).toBe(2);
      expect(requestsTo(harness, "/oauth/token")).toBe(1);
    }),
  );

  it.effect.each([
    { name: "ticket", ticketFails: true, descriptorFails: false },
    { name: "descriptor", ticketFails: false, descriptorFails: true },
    { name: "both requests", ticketFails: true, descriptorFails: true },
  ])(
    "retries only the failed $name with the cached credential",
    ({ ticketFails, descriptorFails }) =>
      Effect.gen(function* () {
        let descriptorReads = 0;
        const harness = yield* makeHarness({
          initialToken: persistedToken(),
          descriptor: () =>
            ++descriptorReads === 1 && descriptorFails
              ? new Response("Bad Gateway", { status: 502 })
              : Response.json(DESCRIPTOR),
          responses: [
            ...(ticketFails ? [new Response("Bad Gateway", { status: 502 })] : []),
            websocketTicket("reconnected"),
          ],
        });
        const authorized = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.use(
          (remote) => remote.authorizeDpop({ expectedEnvironmentId: ENVIRONMENT_ID }),
        ).pipe(Effect.provide(harness.layer));
        expect(authorized.socketUrl).toContain("wsTicket=reconnected");
        expect(authorized.descriptor?.environmentId).toBe(ENVIRONMENT_ID);
        expect(descriptorReads).toBe(descriptorFails ? 2 : 1);
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(0);
        expect(requestsTo(harness, "/api/auth/websocket-ticket/rpc")).toBe(ticketFails ? 2 : 1);
        const proofs = (yield* Ref.get(harness.proofInputs)).filter(
          (proof) => proof.method === "POST",
        );
        expect(proofs.map((proof) => proof.accessToken)).toEqual(
          ticketFails ? ["cached-access-token", "cached-access-token"] : ["cached-access-token"],
        );
        expect(requestsTo(harness, "/oauth/token")).toBe(0);
      }),
  );

  it.effect.each([
    {
      name: "environment mismatch",
      response: () => Response.json({ ...DESCRIPTOR, environmentId: "another-host" }),
      ticket: () => new Response(null, { status: 530 }),
      expected: { _tag: "ConnectionBlockedError", reason: "configuration" },
    },
    {
      name: "an invalid descriptor",
      response: () => Response.json({}),
      ticket: () => websocketTicket("public"),
      expected: { _tag: "ConnectionTransientError", reason: "remote-unavailable" },
    },
    ...[400, 401, 403, 407].map((status) => ({
      name: `HTTP ${status}`,
      response: () => new Response(null, { status }),
      ticket: () =>
        status === 400 ? websocketTicket("public") : new Response(null, { status: 530 }),
      expected: { httpStatus: status },
    })),
  ])("stops on $name returned by a retried public descriptor", ({ response, ticket, expected }) =>
    Effect.gen(function* () {
      let reads = 0;
      const retried = Promise.withResolvers<void>();
      const reply = Promise.withResolvers<Response>();
      const harness = yield* makeHarness({
        initialToken: persistedToken(),
        descriptor: () => {
          if (++reads === 1) return new Response(null, { status: 502 });
          retried.resolve();
          return response();
        },
        responses: [() => reply.promise],
      });
      const attempt = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.use(
        (remote) => remote.authorizeDpop({ expectedEnvironmentId: ENVIRONMENT_ID }),
      ).pipe(Effect.provide(harness.layer), Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => retried.promise);
      yield* TestClock.adjust("1 second");
      reply.resolve(ticket());
      const error = yield* Fiber.join(attempt);
      expect(error).toMatchObject(expected);
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(0);
      expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)).toEqual(persistedToken());
    }),
  );

  it.effect.each(["ticket", "descriptor"] as const)(
    "refreshes a cached endpoint after repeated %s gateway failures",
    (failedRequest) =>
      Effect.gen(function* () {
        let descriptorReads = 0;
        const harness = yield* makeHarness({
          initialToken: persistedToken(),
          descriptor: () =>
            ++descriptorReads <= 2 && failedRequest === "descriptor"
              ? new Response("endpoint unavailable", { status: 503 })
              : Response.json(DESCRIPTOR),
          responses: [
            ...(failedRequest === "ticket"
              ? [
                  new Response("endpoint unavailable", { status: 503 }),
                  new Response("endpoint unavailable", { status: 504 }),
                ]
              : [websocketTicket("unused")]),
            accessToken("replacement-access-token"),
            websocketTicket("replacement-ticket"),
          ],
        });

        const authorized = yield* Effect.gen(function* () {
          const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
          return yield* remote.authorizeDpop({
            expectedEnvironmentId: ENVIRONMENT_ID,
          });
        }).pipe(Effect.provide(harness.layer));

        expect(authorized.socketUrl).toContain("wsTicket=replacement-ticket");
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
        expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)).toEqual(
          expect.objectContaining({
            accessToken: "replacement-access-token",
          }),
        );
        expect(requestsTo(harness, "/api/auth/websocket-ticket/rpc")).toBe(
          failedRequest === "ticket" ? 3 : 2,
        );
        expect(requestsTo(harness, "/oauth/token")).toBe(1);
      }),
  );

  it.effect.each([200, 404, 408, 410, 421, 429, 521, 522, 523, 524, 525, 526, 530])(
    "discovers the new tunnel when unusable metadata (HTTP %i) arrives before a ticket 530",
    (status) =>
      Effect.gen(function* () {
        const oldTicket = Promise.withResolvers<Response>();
        const firstRead = Promise.withResolvers<void>();
        const newEndpoint = {
          ...ENDPOINT,
          httpBaseUrl: "https://new.example.test",
          wsBaseUrl: "wss://new.example.test",
        };
        let reads = 0;
        const harness = yield* makeHarness({
          initialToken: persistedToken(),
          descriptor: () => {
            if (++reads !== 1) return Response.json(DESCRIPTOR);
            firstRead.resolve();
            return new Response(null, { status });
          },
          responses: [
            () => oldTicket.promise,
            accessToken("replacement"),
            websocketTicket("new-address"),
          ],
          bootstrap: { ...BOOTSTRAP, endpoint: newEndpoint },
        });
        const attempting = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.use(
          (service) => service.authorizeDpop({ expectedEnvironmentId: ENVIRONMENT_ID }),
        ).pipe(Effect.provide(harness.layer), Effect.forkChild);
        yield* Effect.promise(() => firstRead.promise);
        yield* TestClock.adjust("1 second");
        oldTicket.resolve(new Response(null, { status: 530 }));
        const socket = yield* Fiber.join(attempting);
        expect(new URL(socket.socketUrl).origin).toBe(newEndpoint.wsBaseUrl);
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
        expect(
          harness.fetch.calls.filter(
            ([url]) => new URL(String(url)).origin === ENDPOINT.httpBaseUrl,
          ),
        ).toHaveLength(2);
      }),
  );

  it.effect.each([
    { request: "ticket", statuses: [502, 503] },
    { request: "descriptor", statuses: [502, 502] },
    { request: "ticket", statuses: [530] },
    { request: "descriptor", statuses: [530] },
    { request: "ticket", statuses: [410] },
    { request: "descriptor", statuses: [410] },
  ])(
    "keeps LAN access and rediscovers the public endpoint after the $request returns $statuses",
    ({ request, statuses }) =>
      Effect.gen(function* () {
        const failures = statuses.map((status) => new Response(null, { status }));
        const relayOnline = yield* Ref.make(false);
        const newEndpoint = {
          ...ENDPOINT,
          httpBaseUrl: "https://new.example.test",
          wsBaseUrl: "wss://new.example.test",
        };
        const harness = yield* makeHarness({
          initialToken: persistedToken(),
          descriptor: () =>
            (request === "descriptor" ? failures.shift() : undefined) ?? Response.json(DESCRIPTOR),
          responses: [
            ...(request === "ticket" ? failures : [websocketTicket("public")]),
            websocketTicket("lan"),
            Response.json({
              authenticated: true,
              auth: {
                policy: "remote-reachable",
                bootstrapMethods: ["one-time-token"],
                sessionMethods: ["dpop-access-token"],
                sessionCookieName: "t3_session",
              },
              scopes: AuthStandardClientScopes,
              sessionMethod: "dpop-access-token",
            }),
            accessToken("rediscovered-token"),
          ],
          bootstrap: { ...BOOTSTRAP, endpoint: newEndpoint },
          beforeBootstrap: requireOnlineRelay(relayOnline),
        });
        yield* Effect.gen(function* () {
          const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
          yield* remote.authorizeDpop({ expectedEnvironmentId: ENVIRONMENT_ID }).pipe(Effect.flip);
          const lan = yield* remote.authorizeDpop({
            expectedEnvironmentId: ENVIRONMENT_ID,
            directEndpoint: {
              httpBaseUrl: "http://192.168.1.10:3773",
              wsBaseUrl: "ws://192.168.1.10:3773",
            },
          });
          expect(lan.socketUrl).toContain("wsTicket=lan");
          expect(lan.httpAuthorization).toMatchObject({ accessToken: "cached-access-token" });
          const session = yield* fetchEnvironmentSessionState({
            prepared: {
              ...lan,
              target: new BearerConnectionTarget({
                environmentId: ENVIRONMENT_ID,
                label: lan.label,
                connectionId: "lan",
              }),
            },
            signer: Option.some(yield* ManagedRelay.ManagedRelayDpopSigner),
            remoteAuthorization: Option.some(remote),
          });
          expect(session.authenticated).toBe(true);
          expect(String(harness.fetch.calls.at(-1)?.[0])).toBe(
            lan.httpBaseUrl + "/api/auth/session",
          );
          yield* Ref.set(relayOnline, true);
          const http = yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
          expect(http.httpBaseUrl).toBe(newEndpoint.httpBaseUrl);
          expect(http.httpAuthorization.accessToken).toBe("rediscovered-token");
        }).pipe(Effect.provide(harness.layer));
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(2);
      }),
  );

  it.effect.each([
    "recovered",
    "different environment",
    "denied by relay",
    "offline at sign-in",
    "unreachable from the relay",
    "timed out from the relay",
    "recovered with one ticket gateway error",
  ] as const)("handles a stale public endpoint that is %s", (host) =>
    Effect.gen(function* () {
      const relayOnline = yield* Ref.make(false);
      const recovered = host !== "different environment" && host !== "denied by relay";
      const relayError =
        host === "unreachable from the relay"
          ? new RelayEnvironmentEndpointUnavailableError({
              code: "environment_endpoint_unavailable",
              reason: "endpoint_request_failed",
              endpointFailure: "unknown",
              endpointStatus: 502,
              traceId: "trace",
            })
          : host === "timed out from the relay"
            ? new RelayEnvironmentEndpointTimedOutError({
                code: "environment_endpoint_timed_out",
                traceId: "trace",
              })
            : undefined;
      const harness = yield* makeHarness({
        initialToken: new TokenStore.RemoteDpopAccessToken({
          ...persistedToken(),
          endpointNeedsDiscovery: true,
        }),
        descriptor: () =>
          Response.json(recovered ? DESCRIPTOR : { ...DESCRIPTOR, environmentId: "other-host" }),
        ...(host === "offline at sign-in"
          ? {
              clerkToken: Effect.fail(
                new ConnectionTransientError({
                  reason: "network",
                  detail: "Sign-in service unavailable",
                }),
              ),
            }
          : {}),
        beforeBootstrap:
          host === "denied by relay" || relayError !== undefined
            ? Effect.fail(
                new ManagedRelay.ManagedRelayRequestFailedError({
                  action: "connect relay environment",
                  cause: relayError ?? "not allowed",
                  ...(relayError ? { relayError } : { status: 403 }),
                }),
              )
            : requireOnlineRelay(relayOnline),
        responses: [
          ...(host === "recovered with one ticket gateway error"
            ? [new Response(null, { status: 502 })]
            : []),
          websocketTicket("recovered"),
          websocketTicket("media"),
        ],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const input = { expectedEnvironmentId: ENVIRONMENT_ID };
        if (recovered) {
          const http = yield* remote.authorizeDpopHttp(input);
          expect(http.httpBaseUrl).toBe(ENDPOINT.httpBaseUrl);
          expect(http.httpAuthorization.accessToken).toBe("cached-access-token");
          const socket = yield* remote.authorizeDpop(input);
          expect(socket.socketUrl).toContain("wsTicket=recovered");
          const discoveries = yield* Ref.get(harness.bootstrapCalls);
          yield* mintMediaTicket({
            ...socket,
            target: new RelayConnectionTarget({
              environmentId: ENVIRONMENT_ID,
              label: socket.label,
            }),
          });
          expect(requestsTo(harness, "/api/auth/websocket-ticket/media")).toBe(1);
          expect(yield* Ref.get(harness.bootstrapCalls)).toBe(discoveries);
        } else if (host === "denied by relay") {
          expect(yield* remote.authorizeDpopHttp(input).pipe(Effect.flip)).toMatchObject({
            httpStatus: 403,
          });
          for (const [url, init] of harness.fetch.calls) {
            expect(String(url)).toBe(ENDPOINT.httpBaseUrl + "/.well-known/t3/environment");
            expect(new Headers(init.headers).has("authorization")).toBe(false);
            expect(new Headers(init.headers).has("dpop")).toBe(false);
          }
        } else {
          expect(yield* remote.authorizeDpop(input).pipe(Effect.flip)).toMatchObject({
            reason: "configuration",
          });
          expect(requestsTo(harness, "/api/auth/websocket-ticket/rpc")).toBe(0);
        }
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps a relay denial authoritative when another tab replaces the cached token", () =>
    Effect.gen(function* () {
      const retryStarted = Promise.withResolvers<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        initialToken: persistedToken(),
        descriptor: DESCRIPTOR,
        beforeBootstrap: Deferred.await(release).pipe(
          Effect.andThen(
            Effect.fail(
              new ManagedRelay.ManagedRelayRequestFailedError({
                action: "connect relay environment",
                cause: "denied",
                status: 403,
              }),
            ),
          ),
        ),
        responses: [
          new Response(null, { status: 502 }),
          () => {
            retryStarted.resolve();
            return new Promise<Response>(() => {});
          },
          websocketTicket("wrong"),
        ],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const attempt = yield* remote
          .authorizeDpop({ expectedEnvironmentId: ENVIRONMENT_ID })
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() => retryStarted.promise);
        yield* TestClock.adjust("3 seconds");
        yield* Ref.set(
          harness.tokens,
          new Map([[ENVIRONMENT_ID, persistedToken({ accessToken: "replacement" })]]),
        );
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(attempt)).toMatchObject({ failure: { httpStatus: 403 } });
        expect(requestsTo(harness, "/api/auth/websocket-ticket/rpc")).toBe(2);
        expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)?.accessToken).toBe(
          "replacement",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect.each(["endpoint_response_invalid", "endpoint_request_failed"] as const)(
    "stops cached authorization after a host verification failure (%s)",
    (reason) =>
      Effect.gen(function* () {
        const relayError = new RelayEnvironmentEndpointUnavailableError({
          code: "environment_endpoint_unavailable",
          reason,
          ...(reason === "endpoint_request_failed"
            ? { endpointFailure: "invalid_response" as const }
            : {}),
          traceId: "trace",
        });
        const harness = yield* makeHarness({
          initialToken: new TokenStore.RemoteDpopAccessToken({
            ...persistedToken(),
            endpointNeedsDiscovery: true,
          }),
          descriptor: DESCRIPTOR,
          responses: [websocketTicket("old")],
          beforeBootstrap: Effect.fail(
            new ManagedRelay.ManagedRelayRequestFailedError({
              action: "connect relay environment",
              cause: relayError,
              relayError,
            }),
          ),
        });
        const error = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.use(
          (remote) => remote.authorizeDpop({ expectedEnvironmentId: ENVIRONMENT_ID }),
        ).pipe(Effect.flip, Effect.provide(harness.layer));
        expect(error).toMatchObject({ failureCause: "invalid_response" });
        expect(requestsTo(harness, "/api/auth/websocket-ticket/rpc")).toBe(0);
      }),
  );

  it.effect.each([
    "stalled ticket",
    "stalled descriptor",
    "second gateway response",
    "successful ticket with a pending descriptor",
    "stalled ticket with a slow exchange at the same address",
  ] as const)(
    "opens the discovered public endpoint within the socket deadline after a %s",
    (retry) =>
      Effect.gen(function* () {
        const retryStarted = Promise.withResolvers<void>();
        const pending = Promise.withResolvers<Response>();
        const mintStarted = Promise.withResolvers<void>();
        const minted = Promise.withResolvers<Response>();
        const sameAddress = retry === "stalled ticket with a slow exchange at the same address";
        const newEndpoint = sameAddress
          ? ENDPOINT
          : {
              ...ENDPOINT,
              httpBaseUrl: "https://new.example.test",
              wsBaseUrl: "wss://new.example.test",
            };
        const oldDescriptor = Promise.withResolvers<Response>();
        const stalled = () => {
          retryStarted.resolve();
          return pending.promise;
        };
        let reads = 0;
        const harness = yield* makeHarness({
          initialToken: persistedToken(),
          bootstrap: { ...BOOTSTRAP, endpoint: newEndpoint },
          beforeBootstrap: sameAddress ? Effect.void : Effect.sleep("6 seconds"),
          descriptor: () => {
            if (retry === "successful ticket with a pending descriptor" && ++reads === 1)
              return oldDescriptor.promise;
            if (retry === "stalled descriptor") {
              if (++reads === 1) return new Response(null, { status: 502 });
              if (reads === 2) return stalled();
            }
            return Response.json(DESCRIPTOR);
          },
          responses: [
            ...(retry !== "stalled descriptor"
              ? [new Response(null, { status: 502 }), stalled]
              : [websocketTicket("old")]),
            sameAddress
              ? () => {
                  mintStarted.resolve();
                  return minted.promise;
                }
              : accessToken("new"),
            websocketTicket("restored"),
          ],
        });
        yield* Effect.gen(function* () {
          const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
          if (sameAddress) {
            yield* Effect.promise(() => mintStarted.promise).pipe(
              Effect.andThen(Effect.sleep("6 seconds")),
              Effect.tap(() => Effect.sync(() => minted.resolve(accessToken("new")))),
              Effect.forkChild,
            );
          }
          const attempt = yield* remote
            .authorizeDpop({ expectedEnvironmentId: ENVIRONMENT_ID })
            .pipe(Effect.timeoutOption("15 seconds"), Effect.forkChild);
          yield* Effect.promise(() => retryStarted.promise);
          yield* TestClock.adjust("3 seconds");
          expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
          if (sameAddress) expect(requestsTo(harness, "/oauth/token")).toBe(1);
          if (retry === "second gateway response")
            pending.resolve(new Response(null, { status: 503 }));
          yield* TestClock.adjust("2 seconds");
          if (retry === "successful ticket with a pending descriptor")
            pending.resolve(websocketTicket("old"));
          yield* TestClock.adjust("10 seconds");
          const restored = Option.getOrThrow(yield* Fiber.join(attempt));
          expect(new URL(restored.socketUrl).origin).toBe(newEndpoint.wsBaseUrl);
          expect(restored.httpAuthorization).toMatchObject({ accessToken: "new" });
          expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect.each(["pending", "temporarily unavailable"] as const)(
    "keeps the original ticket usable while same-address renewal is %s",
    (renewal) =>
      Effect.gen(function* () {
        const retryStarted = Promise.withResolvers<void>();
        const oldTicket = Promise.withResolvers<Response>();
        const exchange = Promise.withResolvers<Response>();
        const harness = yield* makeHarness({
          initialToken: persistedToken(),
          descriptor: DESCRIPTOR,
          responses: [
            new Response(null, { status: 502 }),
            () => {
              retryStarted.resolve();
              return oldTicket.promise;
            },
            () => (renewal === "pending" ? exchange.promise : accessToken("fresh")),
            new Response(null, { status: 410 }),
          ],
        });
        yield* Effect.gen(function* () {
          const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
          const attempt = yield* remote
            .authorizeDpop({ expectedEnvironmentId: ENVIRONMENT_ID })
            .pipe(Effect.forkChild);
          yield* Effect.promise(() => retryStarted.promise);
          yield* TestClock.adjust("7 seconds");
          expect(requestsTo(harness, "/oauth/token")).toBe(1);
          oldTicket.resolve(websocketTicket("original"));
          expect((yield* Fiber.join(attempt)).socketUrl).toContain("wsTicket=original");
          exchange.resolve(accessToken("fresh"));
          if (renewal === "pending") {
            yield* TestClock.adjust(1);
            expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)?.accessToken).toBe(
              "cached-access-token",
            );
          }
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect.each(["deleted", "replaced", "rejected by the host"] as const)(
    "handles a credential %s during same-address renewal",
    (change) =>
      Effect.gen(function* () {
        const retryStarted = Promise.withResolvers<void>();
        const oldTicket = Promise.withResolvers<Response>();
        const exchange = Promise.withResolvers<Response>();
        const harness = yield* makeHarness({
          initialToken: persistedToken(),
          descriptor: DESCRIPTOR,
          responses: [
            new Response(null, { status: 502 }),
            () => {
              retryStarted.resolve();
              return oldTicket.promise;
            },
            () => exchange.promise,
            websocketTicket("other-tab"),
          ],
        });
        yield* Effect.gen(function* () {
          const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
          const attempt = yield* remote
            .authorizeDpop({ expectedEnvironmentId: ENVIRONMENT_ID })
            .pipe(Effect.result, Effect.forkChild);
          yield* Effect.promise(() => retryStarted.promise);
          yield* TestClock.adjust("7 seconds");
          expect(requestsTo(harness, "/oauth/token")).toBe(1);
          const tokens = new Map<EnvironmentId, TokenStore.RemoteDpopAccessToken>();
          if (change === "replaced")
            tokens.set(ENVIRONMENT_ID, persistedToken({ accessToken: "other-tab" }));
          if (change === "rejected by the host") {
            oldTicket.resolve(authInvalid());
            yield* TestClock.adjust(1);
          } else yield* Ref.set(harness.tokens, tokens);
          exchange.resolve(accessToken("late"));
          const result = yield* Fiber.join(attempt);
          if (change === "rejected by the host") {
            expect(result).toMatchObject({
              success: { httpAuthorization: { accessToken: "late" } },
            });
            expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)?.accessToken).toBe("late");
            return;
          }
          expect(yield* Ref.get(harness.tokens)).toEqual(tokens);
          if (change === "deleted") {
            expect(result).toMatchObject({ failure: { reason: "authentication" } });
            expect(requestsTo(harness, "/api/auth/websocket-ticket/rpc")).toBe(2);
          } else {
            expect(result).toMatchObject({
              success: { httpAuthorization: { accessToken: "other-tab" } },
            });
          }
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect.each(["original", "renewed", "renewed in another tab"] as const)(
    "keeps an active session's media using its %s credential when another tab marks its endpoint stale",
    (credential) =>
      Effect.gen(function* () {
        const cached = persistedToken({ expiresAtEpochMs: 120_000 });
        const relayOnline = yield* Ref.make(true);
        const puts = yield* Queue.unbounded<void>();
        const harness = yield* makeHarness({
          initialToken: cached,
          descriptor: DESCRIPTOR,
          responses: [
            websocketTicket("public"),
            ...(credential !== "original" ? [accessToken("renewed")] : []),
            websocketTicket("media"),
          ],
          beforePut: Queue.offer(puts, undefined).pipe(Effect.asVoid),
          beforeBootstrap: Ref.get(relayOnline).pipe(
            Effect.flatMap((online) => (online ? Effect.void : Effect.never)),
          ),
        });
        yield* Effect.gen(function* () {
          const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
          const socket = yield* remote.authorizeDpop({ expectedEnvironmentId: ENVIRONMENT_ID });
          if (credential !== "original") {
            const renew = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.use(
              (service) =>
                service.renewDpopBeforeExpiry({
                  expectedEnvironmentId: ENVIRONMENT_ID,
                  expiresAtEpochMs: cached.expiresAtEpochMs,
                }),
            );
            yield* (
              credential === "renewed"
                ? renew
                : renew.pipe(Effect.provide(Layer.fresh(harness.layer)))
            ).pipe(Effect.forkScoped);
            yield* TestClock.adjust("60 seconds");
            yield* Queue.take(puts);
          }
          yield* Ref.set(relayOnline, false);
          const stored = (yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)!;
          yield* Ref.set(
            harness.tokens,
            new Map([
              [
                ENVIRONMENT_ID,
                new TokenStore.RemoteDpopAccessToken({ ...stored, endpointNeedsDiscovery: true }),
              ],
            ]),
          );
          const request = mintMediaTicket({
            ...socket,
            target: new RelayConnectionTarget({
              environmentId: ENVIRONMENT_ID,
              label: socket.label,
            }),
          });
          const media = yield* request.pipe(Effect.forkChild);
          yield* TestClock.adjust("8 seconds");
          yield* Fiber.join(media);
          expect(yield* Ref.get(harness.bootstrapCalls)).toBe(credential === "original" ? 0 : 1);
          expect((yield* Ref.get(harness.proofInputs)).at(-1)?.accessToken).toBe(
            stored.accessToken,
          );
          yield* Ref.set(harness.tokens, new Map());
          const afterRemoval = yield* request.pipe(Effect.flip, Effect.forkChild);
          yield* TestClock.adjust("8 seconds");
          expect((yield* Fiber.join(afterRemoval))._tag).toBe("RemoteEnvironmentAuthTimeoutError");
          expect(requestsTo(harness, "/api/auth/websocket-ticket/media")).toBe(1);
        }).pipe(Effect.scoped, Effect.provide(harness.layer));
      }),
  );

  it.effect.each(["offline", "denied"] as const)(
    "overlaps public verification with a slow relay that is %s inside the socket deadline",
    (outcome) =>
      Effect.gen(function* () {
        const relayStarted = yield* Deferred.make<void>();
        const relayOnline = yield* Ref.make(false);
        const response = Promise.withResolvers<Response>();
        const harness = yield* makeHarness({
          initialToken: new TokenStore.RemoteDpopAccessToken({
            ...persistedToken(),
            endpointNeedsDiscovery: true,
          }),
          beforeBootstrap: Deferred.succeed(relayStarted, undefined).pipe(
            Effect.andThen(Effect.sleep("10 seconds")),
            Effect.andThen(
              outcome === "offline"
                ? requireOnlineRelay(relayOnline)
                : Effect.fail(
                    new ManagedRelay.ManagedRelayRequestFailedError({
                      action: "connect relay environment",
                      cause: "not allowed",
                      status: 403,
                    }),
                  ),
            ),
          ),
          descriptor: () => response.promise,
          responses: [websocketTicket("within-deadline")],
        });
        yield* Effect.gen(function* () {
          const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
          const attempt = yield* remote
            .authorizeDpop({ expectedEnvironmentId: ENVIRONMENT_ID })
            .pipe(Effect.result, Effect.timeoutOption("15 seconds"), Effect.forkChild);
          yield* Deferred.await(relayStarted);
          yield* TestClock.adjust("6 seconds");
          expect(requestsTo(harness, "/.well-known/t3/environment")).toBe(1);
          response.resolve(Response.json(DESCRIPTOR));
          expect(requestsTo(harness, "/api/auth/websocket-ticket/rpc")).toBe(0);
          yield* TestClock.adjust("4 seconds");
          const result = Option.getOrThrow(yield* Fiber.join(attempt));
          if (outcome === "denied") {
            expect(result).toMatchObject({ failure: { httpStatus: 403 } });
            expect(requestsTo(harness, "/api/auth/websocket-ticket/rpc")).toBe(0);
          } else {
            expect(result).toMatchObject({
              success: { socketUrl: expect.stringContaining("wsTicket=within-deadline") },
            });
          }
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("honors the newly discovered endpoint even when its token exchange fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialToken: new TokenStore.RemoteDpopAccessToken({
          ...persistedToken(),
          endpointNeedsDiscovery: true,
        }),
        bootstrap: {
          ...BOOTSTRAP,
          endpoint: {
            ...ENDPOINT,
            httpBaseUrl: "https://new.example.test",
            wsBaseUrl: "wss://new.example.test",
          },
        },
        descriptor: DESCRIPTOR,
        responses: [new Response(null, { status: 503 })],
      });
      const error = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.use(
        (remote) => remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID }),
      ).pipe(Effect.provide(harness.layer), Effect.flip);
      expect(error).toMatchObject({ httpStatus: 503 });
      expect(String(harness.fetch.calls.at(-1)?.[0])).toBe("https://new.example.test/oauth/token");
    }),
  );

  it.effect.each([
    "descriptor after rediscovery",
    "descriptor retry",
    "ticket retry",
    "ticket retry with the same discovered endpoint",
  ] as const)("gives the public %s its normal request deadline", (phase) =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const response = Promise.withResolvers<Response>();
      const ticketRetry =
        phase === "ticket retry" || phase === "ticket retry with the same discovered endpoint";
      const confirmsSameAddress = phase === "ticket retry with the same discovered endpoint";
      const online = yield* Ref.make(confirmsSameAddress);
      let reads = 0;
      const harness = yield* makeHarness({
        initialToken: new TokenStore.RemoteDpopAccessToken({
          ...persistedToken(),
          ...(phase === "descriptor after rediscovery"
            ? { endpointNeedsDiscovery: true as const }
            : {}),
        }),
        beforeBootstrap: requireOnlineRelay(online),
        descriptor: () => {
          if (ticketRetry) return Response.json(DESCRIPTOR);
          if (++reads === 1 && phase === "descriptor retry")
            return new Response(null, { status: 502 });
          started.resolve();
          return response.promise;
        },
        responses: ticketRetry
          ? [
              new Response(null, { status: 502 }),
              () => {
                started.resolve();
                return response.promise;
              },
              ...(confirmsSameAddress ? [() => new Promise<Response>(() => {})] : []),
            ]
          : [websocketTicket("slow-host")],
      });
      const socket = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const attempt = yield* remote
          .authorizeDpop({ expectedEnvironmentId: ENVIRONMENT_ID })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => started.promise);
        yield* TestClock.adjust("3500 millis");
        response.resolve(ticketRetry ? websocketTicket("slow-host") : Response.json(DESCRIPTOR));
        return yield* Fiber.join(attempt);
      }).pipe(Effect.provide(harness.layer));
      expect(socket.socketUrl).toContain("wsTicket=slow-host");
      expect(requestsTo(harness, "/oauth/token")).toBe(confirmsSameAddress ? 1 : 0);
    }),
  );

  it.effect(
    "preserves the route and gateway status of a failed LAN ticket using a Connect credential",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          initialToken: persistedToken(),
          descriptor: DESCRIPTOR,
          responses: [new Response(null, { status: 502 })],
        });
        const error = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.use(
          (remote) =>
            remote.authorizeDpop({
              expectedEnvironmentId: ENVIRONMENT_ID,
              directEndpoint: {
                httpBaseUrl: "http://192.168.1.10:3773",
                wsBaseUrl: "ws://192.168.1.10:3773",
              },
            }),
        ).pipe(Effect.provide(harness.layer), Effect.flip);
        expect(error).toMatchObject({ via: "direct", httpStatus: 502 });
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(0);
      }),
  );

  it.effect.each(["account change", "credential removal", "credential replacement"] as const)(
    "checks the current authorization before a cached ticket retry after %s",
    (change) =>
      Effect.gen(function* () {
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<Response>();
        const offline = yield* Ref.make(false);
        const harness = yield* makeHarness({
          initialToken: new TokenStore.RemoteDpopAccessToken({
            ...persistedToken(),
            ...(change === "account change" ? {} : { endpointNeedsDiscovery: true }),
          }),
          beforeBootstrap: requireOnlineRelay(offline),
          descriptor: DESCRIPTOR,
          responses: [
            () => {
              started.resolve();
              return release.promise;
            },
            websocketTicket("retried"),
          ],
        });
        const result = yield* Effect.gen(function* () {
          const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
          const attempting = yield* remote
            .authorizeDpop({ expectedEnvironmentId: ENVIRONMENT_ID })
            .pipe(Effect.result, Effect.forkChild);
          yield* Effect.promise(() => started.promise);
          if (change === "account change") {
            yield* Ref.set(harness.session, Option.some({ accountId: "other-account" }));
          } else if (change === "credential removal") {
            yield* Ref.set(harness.tokens, new Map());
          } else {
            yield* Ref.set(
              harness.tokens,
              new Map([[ENVIRONMENT_ID, persistedToken({ accessToken: "replacement" })]]),
            );
          }
          release.resolve(new Response("Bad Gateway", { status: 502 }));
          return yield* Fiber.join(attempting);
        }).pipe(Effect.provide(harness.layer));
        if (change === "credential replacement") {
          expect(result).toMatchObject({
            success: { httpAuthorization: { accessToken: "replacement" } },
          });
          expect(
            (yield* Ref.get(harness.proofInputs))
              .filter((proof) => proof.method === "POST")
              .map((proof) => proof.accessToken),
          ).toEqual(["cached-access-token", "replacement"]);
        } else {
          expect(result).toMatchObject({
            failure: { _tag: "ConnectionBlockedError", reason: "authentication" },
          });
          expect(requestsTo(harness, "/api/auth/websocket-ticket/rpc")).toBe(1);
        }
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(change === "account change" ? 0 : 1);
      }),
  );

  it.effect("stops rediscovery when sign-in changes while marking the cached endpoint stale", () =>
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        initialToken: persistedToken(),
        descriptor: DESCRIPTOR,
        beforePut: Deferred.succeed(writing, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
        responses: [new Response(null, { status: 502 }), new Response(null, { status: 502 })],
      });
      const result = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const socket = yield* remote
          .authorizeDpop({ expectedEnvironmentId: ENVIRONMENT_ID })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(writing);
        yield* Ref.set(harness.session, Option.some({ accountId: "other-account" }));
        yield* Deferred.succeed(release, undefined);
        return yield* Fiber.join(socket);
      }).pipe(Effect.provide(harness.layer));
      expect(result).toMatchObject({ _tag: "ConnectionBlockedError", reason: "authentication" });
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(0);
    }),
  );

  it.effect("removes a newly refreshed token when the host rejects it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [Response.json(DESCRIPTOR), accessToken("unusable-access-token"), authInvalid()],
      });

      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpop({
          expectedEnvironmentId: ENVIRONMENT_ID,
        });
      }).pipe(Effect.provide(harness.layer), Effect.flip);

      expect((yield* Ref.get(harness.tokens)).has(ENVIRONMENT_ID)).toBe(false);
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect(harness.fetch.calls).toHaveLength(3);
    }),
  );

  it.effect.each(["gateway", "network"] as const)(
    "keeps a rediscovered credential for LAN after a public ticket %s error",
    (failure) =>
      Effect.gen(function* () {
        let descriptorReads = 0;
        const relayOnline = yield* Ref.make(true);
        const harness = yield* makeHarness({
          initialToken: persistedToken(),
          descriptor: () =>
            ++descriptorReads <= 2
              ? new Response(null, { status: 502 })
              : Response.json(DESCRIPTOR),
          beforeBootstrap: requireOnlineRelay(relayOnline),
          responses: [
            websocketTicket("old-endpoint"),
            accessToken("new-token"),
            failure === "gateway"
              ? new Response(null, { status: 502 })
              : () => Promise.reject(new TypeError("network offline")),
            websocketTicket("lan"),
          ],
        });
        yield* Effect.gen(function* () {
          const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
          const input = { expectedEnvironmentId: ENVIRONMENT_ID };
          const error = yield* remote.authorizeDpop(input).pipe(Effect.flip);
          expect(error).toMatchObject({
            via: "relay",
            reason: failure === "gateway" ? "remote-unavailable" : "network",
          });
          yield* Ref.set(relayOnline, false);
          const lan = yield* remote.authorizeDpop({
            ...input,
            directEndpoint: {
              httpBaseUrl: "http://192.168.1.10:3773",
              wsBaseUrl: "ws://192.168.1.10:3773",
            },
          });
          expect(lan.socketUrl).toContain("wsTicket=lan");
          expect(lan.httpAuthorization).toMatchObject({ accessToken: "new-token" });
          expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("does not evict a replacement token when a late request rejects the old one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialToken: persistedToken(),
        responses: [Response.json(DESCRIPTOR), accessToken("replacement-token")],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const initial = yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
        const retry = {
          expectedEnvironmentId: ENVIRONMENT_ID,
          rejectedAccessToken: initial.httpAuthorization.accessToken,
        };
        const first = yield* remote.authorizeDpopHttp(retry);
        const late = yield* remote.authorizeDpopHttp(retry);
        expect(first.httpAuthorization.accessToken).toBe("replacement-token");
        expect(late).toEqual(first);
      }).pipe(Effect.provide(harness.layer));

      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect(harness.fetch.calls).toHaveLength(2);
      expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)?.accessToken).toBe(
        "replacement-token",
      );
    }),
  );

  it.effect("gives a concurrently renewed credential the normal ticket deadline", () =>
    Effect.gen(function* () {
      const oldStarted = Promise.withResolvers<void>();
      const oldResponse = Promise.withResolvers<Response>();
      const renewedStarted = Promise.withResolvers<void>();
      const renewedResponse = Promise.withResolvers<Response>();
      const harness = yield* makeHarness({
        initialToken: persistedToken(),
        descriptor: DESCRIPTOR,
        responses: [
          () => {
            oldStarted.resolve();
            return oldResponse.promise;
          },
          accessToken("replacement-token"),
          () => {
            renewedStarted.resolve();
            return renewedResponse.promise;
          },
        ],
      });
      const connected = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const input = { expectedEnvironmentId: ENVIRONMENT_ID };
        const socket = yield* remote.authorizeDpop(input).pipe(Effect.forkChild);
        yield* Effect.promise(() => oldStarted.promise);
        yield* remote.authorizeDpopHttp({ ...input, rejectedAccessToken: "cached-access-token" });
        oldResponse.resolve(authInvalid());
        yield* Effect.promise(() => renewedStarted.promise);
        yield* TestClock.adjust("3500 millis");
        renewedResponse.resolve(websocketTicket("renewed-ticket"));
        return yield* Fiber.join(socket);
      }).pipe(Effect.provide(harness.layer));
      expect(connected.socketUrl).toContain("wsTicket=renewed-ticket");
      expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)?.accessToken).toBe(
        "replacement-token",
      );
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
    }),
  );

  it.effect("shares one in-flight renewal between concurrent HTTP requests", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        initialToken: persistedToken({ expiresAtEpochMs: 0 }),
        beforeBootstrap: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
        responses: [Response.json(DESCRIPTOR), accessToken("shared-token")],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const requests = yield* Effect.all(
          Array.from({ length: 6 }, () =>
            remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID }),
          ),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* Queue.takeN(harness.tokenReads, 6);
        yield* Deferred.await(started);
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
        yield* Deferred.succeed(release, undefined);
        const results = yield* Fiber.join(requests);
        expect(results.map((result) => result.httpAuthorization.accessToken)).toEqual(
          Array(6).fill("shared-token"),
        );
      }).pipe(Effect.provide(harness.layer));

      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect(harness.fetch.calls).toHaveLength(2);
    }),
  );

  it.effect(
    "shares a failed renewal and allows a later attempt instead of caching its failure",
    () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void, ManagedRelay.ManagedRelayClientError>();
        const failure = new ManagedRelay.ManagedRelayRequestTimeoutError({
          activity: "Relay environment connection",
          timeoutMs: ManagedRelay.MANAGED_RELAY_REQUEST_TIMEOUT_MS,
          traceId: null,
        });
        const harness = yield* makeHarness({
          responses: [],
          beforeBootstrap: Deferred.await(release),
        });
        yield* Effect.gen(function* () {
          const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
          const requests = yield* Effect.all(
            Array.from({ length: 6 }, () =>
              remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID }).pipe(Effect.flip),
            ),
            { concurrency: "unbounded" },
          ).pipe(Effect.forkChild);
          yield* Queue.takeN(harness.tokenReads, 6);
          yield* Deferred.fail(release, failure);
          const failures = yield* Fiber.join(requests);
          expect(failures).toEqual(
            Array(6).fill(
              expect.objectContaining({
                _tag: "ConnectionTransientError",
                reason: "timeout",
              }),
            ),
          );
          expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
          yield* remote
            .authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID })
            .pipe(Effect.flip);
          expect(yield* Ref.get(harness.bootstrapCalls)).toBe(2);
        }).pipe(Effect.provide(harness.layer));
        expect(harness.fetch.calls).toHaveLength(0);
      }),
  );

  it.effect("does not block another environment behind a pending renewal", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const otherEnvironmentId = EnvironmentId.make("environment-2");
      const harness = yield* makeHarness({
        initialToken: persistedToken({
          environmentId: otherEnvironmentId,
          accessToken: "other-token",
        }),
        beforeBootstrap: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
        responses: [Response.json(DESCRIPTOR), accessToken("fresh-token")],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const pending = yield* remote
          .authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const other = yield* remote.authorizeDpopHttp({
          expectedEnvironmentId: otherEnvironmentId,
        });
        expect(other.httpAuthorization.accessToken).toBe("other-token");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(pending);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("retries instead of blocking while the cloud session has not loaded", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [Response.json(DESCRIPTOR), accessToken("loaded-token")],
      });
      yield* Ref.set(harness.session, Option.none());
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const pending = yield* remote
          .authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID })
          .pipe(Effect.flip);
        expect(pending).toMatchObject({
          _tag: "ConnectionTransientError",
          reason: "session-pending",
        });
        yield* Ref.set(harness.session, Option.some({ accountId: "account-1" }));
        const loaded = yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
        expect(loaded.httpAuthorization.accessToken).toBe("loaded-token");
      }).pipe(Effect.provide(harness.layer));
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
    }),
  );

  it.effect("does not return or persist credentials after logout during renewal", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        beforeBootstrap: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
        responses: [],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const pending = yield* remote
          .authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(started);
        yield* Ref.set(harness.session, Option.none());
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(pending)).toMatchObject({
          _tag: "ConnectionBlockedError",
          reason: "authentication",
        });
      }).pipe(Effect.provide(harness.layer));
      expect((yield* Ref.get(harness.tokens)).size).toBe(0);
      expect(harness.fetch.calls).toHaveLength(0);
    }),
  );

  it.effect("removes an obsolete credential if logout overlaps the persistent write", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        beforePut: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
        responses: [Response.json(DESCRIPTOR), accessToken("obsolete-token")],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const pending = yield* remote
          .authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(started);
        yield* Ref.set(harness.session, Option.none());
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(pending)).toMatchObject({
          _tag: "ConnectionBlockedError",
          reason: "authentication",
        });
      }).pipe(Effect.provide(harness.layer));
      expect((yield* Ref.get(harness.tokens)).size).toBe(0);
    }),
  );

  it.effect(
    "renews another account's persisted token after the authorization service restarts",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          initialToken: persistedToken(),
          responses: [Response.json(DESCRIPTOR), accessToken("account-2-token")],
        });
        const authorize = Effect.gen(function* () {
          const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
          return yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
        }).pipe(Effect.provide(harness.layer));

        expect((yield* authorize).httpAuthorization.accessToken).toBe("cached-access-token");
        yield* Ref.set(harness.session, Option.some({ accountId: "account-2" }));
        expect((yield* authorize).httpAuthorization.accessToken).toBe("account-2-token");
        expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)?.accountId).toBe("account-2");

        yield* Ref.set(harness.session, Option.some({ accountId: "account-2" }));
        expect((yield* authorize).httpAuthorization.accessToken).toBe("account-2-token");
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
        expect(harness.fetch.calls).toHaveLength(2);
      }),
  );

  it.effect("renews a legacy unowned token once and reuses its account-bound replacement", () =>
    Effect.gen(function* () {
      const legacy = new TokenStore.RemoteDpopAccessToken({
        environmentId: ENVIRONMENT_ID,
        label: DESCRIPTOR.label,
        endpoint: ENDPOINT,
        accessToken: "legacy-access-token",
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        dpopThumbprint: "thumbprint-1",
      });
      const harness = yield* makeHarness({
        initialToken: legacy,
        responses: [Response.json(DESCRIPTOR), accessToken("account-bound-token")],
      });
      const authorize = Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
      }).pipe(Effect.provide(harness.layer));

      expect((yield* authorize).httpAuthorization.accessToken).toBe("account-bound-token");
      expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)?.accountId).toBe("account-1");
      expect((yield* authorize).httpAuthorization.accessToken).toBe("account-bound-token");
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect(harness.fetch.calls).toHaveLength(2);
    }),
  );

  it.effect("requires fresh credentials after signing back into the same account", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialToken: persistedToken(),
        responses: [Response.json(DESCRIPTOR), accessToken("new-session-token")],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
        yield* Ref.set(harness.session, Option.none());
        yield* Ref.set(harness.session, Option.some({ accountId: "account-1" }));
        const signedIn = yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
        expect(signedIn.httpAuthorization.accessToken).toBe("new-session-token");
      }).pipe(Effect.provide(harness.layer));
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
    }),
  );

  it.effect("renews a cached credential bound to a different signing key", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialToken: persistedToken(),
        responses: [Response.json(DESCRIPTOR), accessToken("new-key-token")],
      });
      yield* Ref.set(harness.thumbprint, "thumbprint-2");
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorized = yield* remote.authorizeDpopHttp({
          expectedEnvironmentId: ENVIRONMENT_ID,
        });
        expect(authorized.httpAuthorization.accessToken).toBe("new-key-token");
      }).pipe(Effect.provide(harness.layer));
      expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)?.dpopThumbprint).toBe(
        "thumbprint-2",
      );
    }),
  );

  it.effect("rejects a relay bootstrap for a different environment before contacting it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [],
        bootstrap: { ...BOOTSTRAP, environmentId: EnvironmentId.make("wrong-environment") },
      });
      const failure = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
      }).pipe(Effect.provide(harness.layer), Effect.flip);
      expect(failure).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
      expect(harness.fetch.calls).toHaveLength(0);
    }),
  );

  it.effect("keeps a shared renewal alive when one waiting request is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        beforeBootstrap: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
        responses: [Response.json(DESCRIPTOR), accessToken("fresh-token")],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const pending = yield* remote
          .authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const other = yield* remote
          .authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID })
          .pipe(Effect.forkChild);
        yield* Queue.takeN(harness.tokenReads, 2);
        yield* Fiber.interrupt(pending);
        yield* Deferred.succeed(release, undefined);
        const authorized = yield* Fiber.join(other);
        expect(authorized.httpAuthorization.accessToken).toBe("fresh-token");
        const cached = yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
        expect(cached).toEqual(authorized);
      }).pipe(Effect.provide(harness.layer));
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
    }),
  );
});

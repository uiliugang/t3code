import { msg } from "gt-i18n";
import { translatableDetail } from "../errors/translatable.ts";
import {
  AuthAccessTokenType,
  connectDeviceVerificationCode,
  type ClientConnectionMethod,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { RelayEnvironmentConnectScope } from "@t3tools/contracts/relay";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import {
  exchangeRemoteDpopAccessToken,
  type RemoteEnvironmentAuthError,
  resolveRemoteDpopWebSocketConnectionUrl,
  resolveRemoteWebSocketConnectionUrl,
} from "./remote.ts";
import {
  credentialMissingError,
  isGatewayStatus,
  environmentMismatchError,
  mapManagedRelayError,
  mapRemoteDpopEnvironmentError,
  mapRemoteEnvironmentError,
} from "../connection/errors.ts";
import { DpopConnectionCredential } from "../connection/catalog.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
  type DirectDpopConnection,
} from "../connection/model.ts";
import { isNearbyAddress } from "../connection/routes.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as TokenStore from "./tokenStore.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";

import {
  DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";

export interface AuthorizedRemoteEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization;
  readonly descriptor?: ExecutionEnvironmentDescriptor;
}

export interface AuthorizedRemoteHttpEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly httpAuthorization: Extract<PreparedHttpAuthorization, { readonly _tag: "Dpop" }>;
}

export class RemoteEnvironmentAuthorization extends Context.Service<
  RemoteEnvironmentAuthorization,
  {
    readonly authorizeBearer: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeDpop: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      /**
       * The access token is not bound to an origin, and each proof is minted
       * for the URL it signs, so a token from the relay also works on the
       * environment's LAN or tailnet address.
       */
      readonly directEndpoint?: { readonly httpBaseUrl: string; readonly wsBaseUrl: string };
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    /** A saved address paired with this device's DPoP key, which renews with the host itself. */
    readonly authorizeDirectDpop: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly connectionId: string;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeDirectDpopHttp: (
      connection: DirectDpopConnection,
      rejectedAccessToken?: string,
    ) => Effect.Effect<
      Extract<PreparedHttpAuthorization, { readonly _tag: "Dpop" }>,
      ConnectionAttemptError
    >;
    readonly authorizeDpopHttp: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly rejectedAccessToken?: string;
      readonly directEndpoint?: { readonly httpBaseUrl: string };
      readonly preparedEndpoint?: { readonly httpBaseUrl: string; readonly accessToken: string };
    }) => Effect.Effect<AuthorizedRemoteHttpEnvironment, ConnectionAttemptError>;
    /**
     * Lets the next direct authorization of this address skip its own descriptor
     * read. Kept only where the address reaches the same machine on every network.
     */
    readonly rememberCheckedDescriptor: (
      httpBaseUrl: string,
      descriptor: Option.Option<ExecutionEnvironmentDescriptor>,
      keepsItsHost: boolean,
    ) => Effect.Effect<void>;
    /**
     * Renews a live socket's token before it expires, so the server moves the
     * socket to the new session instead of closing it. Runs until interrupted.
     */
    readonly renewDpopBeforeExpiry: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly expiresAtEpochMs: number;
      readonly directConnection?: DirectDpopConnection;
    }) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/authorization/service/RemoteEnvironmentAuthorization") {}

const CACHED_ENDPOINT_SOCKET_TIMEOUT_MS = 3_000;
const DPOP_AUTHORIZATION_TIMEOUT_MS = 30_000;
const CHECKED_DESCRIPTOR_TTL_NANOS = 5_000_000_000n;
// A loopback or LAN host answers well inside this, so a dead one frees its attempt sooner.
const NEARBY_DESCRIPTOR_TIMEOUT_MS = 3_000;

interface ResolvedDpopToken {
  readonly source: "cache" | "verified-cache" | "exchange";
  readonly token: TokenStore.RemoteDpopAccessToken;
  readonly descriptor?: ExecutionEnvironmentDescriptor;
}

interface DiscoveryUnavailable {
  readonly _tag: "DiscoveryUnavailable";
  readonly cause: ConnectionAttemptError;
}

type TokenExchangeError = ConnectionAttemptError | DiscoveryUnavailable;

function isGatewayError(error: RemoteEnvironmentAuthError | ConnectionAttemptError) {
  return (
    error._tag === "RemoteEnvironmentAuthUndeclaredStatusError" && isGatewayStatus(error.status)
  );
}

function isEndpointUnavailable(error: RemoteEnvironmentAuthError | ConnectionAttemptError) {
  if (error._tag === "RemoteEnvironmentAuthUndeclaredStatusError") {
    const { status } = error;
    return [404, 408, 410, 421, 429].includes(status) || (status >= 500 && status < 600);
  }
  return (
    error._tag === "RemoteEnvironmentAuthFetchError" ||
    error._tag === "RemoteEnvironmentAuthTimeoutError"
  );
}

function matchesUsableToken(
  current: TokenStore.RemoteDpopAccessToken,
  expected: TokenStore.RemoteDpopAccessToken,
  now: number,
) {
  return (
    current.accessToken === expected.accessToken &&
    current.accountId === expected.accountId &&
    current.dpopThumbprint === expected.dpopThumbprint &&
    current.endpoint.httpBaseUrl === expected.endpoint.httpBaseUrl &&
    current.expiresAtEpochMs > now + DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS
  );
}

function isDiscoveryUnavailable(error: ConnectionAttemptError) {
  if (
    error._tag !== "ConnectionTransientError" ||
    error.reason === "session-pending" ||
    error.reason === "approval-pending" ||
    error.failureCause === "tunnel_pending" ||
    error.failureCause === "invalid_response"
  )
    return false;
  const status = error.httpStatus;
  return status === undefined || status === 0 || status === 408 || status === 429 || status >= 500;
}

function mapDpopSocketError(
  error: RemoteEnvironmentAuthError | ConnectionAttemptError,
  via: "relay" | "direct",
) {
  return error._tag === "ConnectionTransientError" || error._tag === "ConnectionBlockedError"
    ? error
    : mapRemoteDpopEnvironmentError(error, via);
}

function approvalPendingError(hostLabel: string, thumbprint: string, traceId: string) {
  const verificationCode = connectDeviceVerificationCode(thumbprint);
  return new ConnectionTransientError({
    reason: "approval-pending",
    ...translatableDetail(
      msg("Approve this device on {host}. It shows code {verificationCode}.", {
        host: hostLabel,
        verificationCode,
      }),
    ),
    verificationCode,
    traceId,
    hop: "server",
    via: "relay",
    failureCause: "approval_pending",
  });
}

const fetchDescriptor = Effect.fn("clientRuntime.connection.remote.fetchDescriptor")(function* (
  httpBaseUrl: string,
  connectionMethod: ClientConnectionMethod,
  timeoutMs?: number,
) {
  return yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }).pipe(Effect.mapError((error) => mapRemoteEnvironmentError(error, connectionMethod)));
});

export const make = Effect.gen(function* () {
  const serviceScope = yield* Scope.Scope;
  const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
  const relay = yield* ManagedRelay.ManagedRelayClient;
  const cloudSession = yield* ClientCapabilities.CloudSession;
  const deviceIdentity = yield* ClientCapabilities.RelayDeviceIdentity;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const tokenStore = yield* TokenStore.RemoteDpopAccessTokenStore;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const httpClient = yield* HttpClient.HttpClient;
  const tokenLock = yield* Semaphore.make(1);
  const directTokenLocks = yield* KeyedLock.make<string>();
  const tokenOwners = new Map<
    EnvironmentId,
    { readonly accessToken: string; readonly identity: ClientCapabilities.CloudSessionIdentity }
  >();
  const pendingTokens = new Map<
    EnvironmentId,
    {
      readonly id: object;
      readonly identity: ClientCapabilities.CloudSessionIdentity;
      readonly thumbprint: string;
      readonly issued: Effect.Effect<ResolvedDpopToken, TokenExchangeError>;
    }
  >();

  // A route or host check hands its descriptor to the connect it leads to, once,
  // so the connect skips a round trip. Only over HTTPS or loopback: any other
  // plain http address can belong to another machine after a network change.
  const checkedDescriptors = new Map<
    string,
    { readonly descriptor: ExecutionEnvironmentDescriptor; readonly at: bigint }
  >();

  /**
   * A saved LAN address can belong to another machine on a different network.
   */
  const verifyDirectEndpoint = Effect.fn("clientRuntime.connection.remote.verifyDirectEndpoint")(
    function* (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) {
      const checked = checkedDescriptors.get(input.httpBaseUrl);
      checkedDescriptors.delete(input.httpBaseUrl);
      // A remembered mismatch still reads again, so a host that answers for the
      // right environment a moment later is not blocked.
      const descriptor =
        checked !== undefined &&
        checked.descriptor.environmentId === input.expectedEnvironmentId &&
        (yield* Clock.monotonicTimeNanos) - checked.at <= CHECKED_DESCRIPTOR_TTL_NANOS
          ? checked.descriptor
          : yield* fetchDescriptor(
              input.httpBaseUrl,
              input.connectionMethod,
              // An SSH forward listens on loopback but reaches a remote host.
              input.connectionMethod === "direct" && isNearbyAddress(input.httpBaseUrl)
                ? NEARBY_DESCRIPTOR_TIMEOUT_MS
                : undefined,
            ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: descriptor.environmentId,
        });
      }
      return descriptor;
    },
  );

  const authorizeBearer = Effect.fn("clientRuntime.connection.remote.authorizeBearer")(
    function* (input: {
      readonly expectedEnvironmentId: Parameters<
        RemoteEnvironmentAuthorization["Service"]["authorizeBearer"]
      >[0]["expectedEnvironmentId"];
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) {
      const descriptor = yield* verifyDirectEndpoint(input);
      const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: input.wsBaseUrl,
        httpBaseUrl: input.httpBaseUrl,
        bearerToken: input.bearerToken,
        clientMetadata: presentation.metadata,
        connectionMethod: input.connectionMethod,
      }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        socketUrl,
        descriptor,
        httpAuthorization: {
          _tag: "Bearer" as const,
          token: input.bearerToken,
        },
      };
    },
  );

  const createDpopSocketUrl = Effect.fn("clientRuntime.connection.remote.createDpopSocketUrl")(
    function* (
      token: TokenStore.RemoteDpopAccessToken,
      timeoutMs?: number,
      endpoint: { readonly httpBaseUrl: string; readonly wsBaseUrl: string } = token.endpoint,
    ) {
      return yield* resolveRemoteDpopWebSocketConnectionUrl({
        wsBaseUrl: endpoint.wsBaseUrl,
        httpBaseUrl: endpoint.httpBaseUrl,
        accessToken: token.accessToken,
        createProof: (proof) =>
          signer.createProof(proof).pipe(
            Effect.mapError(
              () =>
                new ConnectionBlockedError({
                  reason: "configuration",
                  ...translatableDetail(msg("Could not create the websocket authorization proof.")),
                }),
            ),
          ),
        clientMetadata: presentation.metadata,
        connectionMethod: "relay",
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    },
    Effect.provideService(HttpClient.HttpClient, httpClient),
  );

  const sessionChanged = () =>
    new ConnectionBlockedError({
      reason: "authentication",
      ...translatableDetail(
        msg("Your cloud sign-in changed. Sign in again to authorize the environment."),
      ),
    });

  // A missing identity before the attempt captures one means the cloud session
  // is still loading, not a sign-out. Only a captured identity that goes away
  // or changes is evidence of one.
  const sessionPending = () =>
    new ConnectionTransientError({
      reason: "session-pending",
      ...translatableDetail(msg("Waiting for the T3 Connect sign-in to load.")),
    });

  const assertSession = Effect.fnUntraced(function* (
    identity: ClientCapabilities.CloudSessionIdentity,
  ) {
    const current = yield* cloudSession.identity;
    if (Option.isNone(current) || current.value !== identity) {
      return yield* sessionChanged();
    }
  });

  // Called under tokenLock so a late rejection cannot remove a newer credential.
  const removeRejectedToken = Effect.fnUntraced(function* (
    environmentId: EnvironmentId,
    accessToken: string,
  ) {
    const cached = yield* tokenStore.get(environmentId);
    if (Option.isSome(cached) && cached.value.accessToken === accessToken) {
      yield* tokenStore.remove(environmentId);
      tokenOwners.delete(environmentId);
    }
  });

  const obtainBootstrap = Effect.fn("relay.connection.bootstrap.obtain")(function* (
    environmentId: EnvironmentId,
    identity: ClientCapabilities.CloudSessionIdentity,
  ) {
    yield* assertSession(identity);
    const clerkToken = yield* cloudSession.clerkToken.pipe(
      Effect.withSpan("relay.connection.cloudSessionToken.resolve"),
    );
    const deviceId = yield* deviceIdentity.deviceId.pipe(
      Effect.withSpan("relay.connection.deviceIdentity.resolve"),
    );
    yield* assertSession(identity);
    const connected = yield* relay
      .connectEnvironment({
        clerkToken,
        scopes: [RelayEnvironmentConnectScope],
        environmentId,
        ...(Option.isSome(deviceId) ? { deviceId: deviceId.value } : {}),
      })
      .pipe(Effect.mapError(mapManagedRelayError));
    if (connected.environmentId !== environmentId) {
      return yield* environmentMismatchError({
        expected: environmentId,
        actual: connected.environmentId,
      });
    }
    yield* assertSession(identity);
    return connected;
  });

  const exchangeDpopToken = Effect.fn("clientRuntime.connection.remote.exchangeDpopToken")(
    function* (
      environmentId: EnvironmentId,
      thumbprint: string,
      identity: ClientCapabilities.CloudSessionIdentity,
      discovery: ReturnType<typeof obtainBootstrap>,
    ) {
      const bootstrap = yield* discovery.pipe(
        Effect.mapError((cause): TokenExchangeError =>
          isDiscoveryUnavailable(cause) ? { _tag: "DiscoveryUnavailable", cause } : cause,
        ),
      );
      const descriptor = yield* fetchDescriptor(bootstrap.endpoint.httpBaseUrl, "relay").pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.withSpan("environment.authorization.descriptor"),
      );
      if (descriptor.environmentId !== environmentId) {
        return yield* environmentMismatchError({
          expected: environmentId,
          actual: descriptor.environmentId,
        });
      }
      const bootstrapProof = yield* signer
        .createProof({
          method: "POST",
          url: environmentEndpointUrl(bootstrap.endpoint.httpBaseUrl, "/oauth/token"),
        })
        .pipe(
          Effect.mapError(
            () =>
              new ConnectionBlockedError({
                reason: "configuration",
                ...translatableDetail(msg("Could not create the environment authorization proof.")),
              }),
          ),
        );
      yield* assertSession(identity);
      const access = yield* exchangeRemoteDpopAccessToken({
        httpBaseUrl: bootstrap.endpoint.httpBaseUrl,
        credential: bootstrap.credential,
        dpopProof: bootstrapProof,
        clientMetadata: presentation.metadata,
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "EnvironmentConnectApprovalPendingError"
            ? approvalPendingError(descriptor.label, thumbprint, error.traceId)
            : mapRemoteDpopEnvironmentError(error),
        ),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.withSpan("environment.authorization.accessToken.exchange"),
      );
      const issuedAt = yield* Clock.currentTimeMillis;
      const token = new TokenStore.RemoteDpopAccessToken({
        environmentId: descriptor.environmentId,
        accountId: identity.accountId,
        label: descriptor.label,
        endpoint: bootstrap.endpoint,
        accessToken: access.access_token,
        expiresAtEpochMs: issuedAt + access.expires_in * 1_000,
        dpopThumbprint: thumbprint,
      });
      return { source: "exchange", token, descriptor } satisfies ResolvedDpopToken;
    },
  );

  const markEndpointStale = (token: TokenStore.RemoteDpopAccessToken) =>
    tokenStore.put(
      new TokenStore.RemoteDpopAccessToken({ ...token, endpointNeedsDiscovery: true }),
      token.accessToken,
    );

  const rediscoverOrVerifyCachedEndpoint = Effect.fn(
    "clientRuntime.connection.remote.verifyCachedPublicEndpoint",
  )(function* (
    token: TokenStore.RemoteDpopAccessToken,
    identity: ClientCapabilities.CloudSessionIdentity,
    discovery: Effect.Effect<ResolvedDpopToken, TokenExchangeError>,
  ) {
    // Only public metadata can be read before the relay makes its authorization decision.
    const reading = yield* fetchDescriptor(token.endpoint.httpBaseUrl, "relay").pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.forkScoped,
    );
    const discovered = yield* Effect.result(discovery);
    if (Result.isSuccess(discovered)) return discovered.success;
    const error = discovered.failure;
    if (error._tag !== "DiscoveryUnavailable") return yield* error;
    const descriptor = yield* Fiber.join(reading);
    yield* assertSession(identity);
    if (descriptor.environmentId !== token.environmentId) {
      return yield* environmentMismatchError({
        expected: token.environmentId,
        actual: descriptor.environmentId,
      });
    }
    const current = yield* tokenStore.get(token.environmentId);
    if (
      Option.isNone(current) ||
      !matchesUsableToken(current.value, token, yield* Clock.currentTimeMillis)
    ) {
      return yield* error.cause;
    }
    return {
      source: "verified-cache",
      token: current.value,
      descriptor,
    } satisfies ResolvedDpopToken;
  }, Effect.scoped);

  const getDpopToken = Effect.fn("clientRuntime.connection.remote.getDpopToken")(function* (
    input: Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDpopHttp"]>[0],
    expectedIdentity?: ClientCapabilities.CloudSessionIdentity,
    discovery?: ReturnType<typeof obtainBootstrap>,
  ) {
    const session = yield* cloudSession.identity;
    if (Option.isNone(session)) {
      return yield* sessionPending();
    }
    const identity = session.value;
    if (expectedIdentity !== undefined && identity !== expectedIdentity)
      return yield* sessionChanged();
    const thumbprint = yield* signer.thumbprint.pipe(
      Effect.mapError(
        () =>
          new ConnectionBlockedError({
            reason: "configuration",
            ...translatableDetail(msg("Could not load the environment authorization key.")),
          }),
      ),
      Effect.withSpan("environment.authorization.dpopKey.resolve"),
    );
    let staleEndpoint: TokenStore.RemoteDpopAccessToken | undefined;
    const selected = yield* tokenLock.withPermits(1)(
      Effect.gen(function* () {
        yield* assertSession(identity);
        const now = yield* Clock.currentTimeMillis;
        const cached = yield* tokenStore
          .get(input.expectedEnvironmentId)
          .pipe(Effect.withSpan("environment.authorization.accessToken.cache"));
        const owner = tokenOwners.get(input.expectedEnvironmentId);
        if (
          Option.isSome(cached) &&
          cached.value.environmentId === input.expectedEnvironmentId &&
          cached.value.accountId === identity.accountId &&
          cached.value.dpopThumbprint === thumbprint &&
          cached.value.expiresAtEpochMs > now + DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS &&
          cached.value.accessToken !== input.rejectedAccessToken &&
          (owner?.accessToken !== cached.value.accessToken || owner.identity === identity)
        ) {
          tokenOwners.set(input.expectedEnvironmentId, {
            accessToken: cached.value.accessToken,
            identity,
          });
          if (
            input.directEndpoint !== undefined ||
            !cached.value.endpointNeedsDiscovery ||
            (input.preparedEndpoint?.accessToken === cached.value.accessToken &&
              input.preparedEndpoint.httpBaseUrl === cached.value.endpoint.httpBaseUrl)
          ) {
            return Effect.succeed<ResolvedDpopToken>({ source: "cache", token: cached.value });
          }
          // A socket that just confirmed the outage has already probed this endpoint.
          if (expectedIdentity === undefined) staleEndpoint = cached.value;
        }
        if (input.rejectedAccessToken !== undefined) {
          yield* removeRejectedToken(input.expectedEnvironmentId, input.rejectedAccessToken);
        }
        const pending = pendingTokens.get(input.expectedEnvironmentId);
        if (pending?.identity === identity && pending.thumbprint === thumbprint) {
          return pending.issued;
        }

        const id = {};
        const fiber = yield* exchangeDpopToken(
          input.expectedEnvironmentId,
          thumbprint,
          identity,
          discovery ?? obtainBootstrap(input.expectedEnvironmentId, identity),
        ).pipe(
          Effect.flatMap((issued) =>
            tokenLock.withPermits(1)(
              Effect.gen(function* () {
                const { token } = issued;
                yield* assertSession(identity);
                yield* tokenStore
                  .put(token)
                  .pipe(Effect.withSpan("environment.authorization.accessToken.persist"));
                const current = yield* cloudSession.identity;
                if (Option.isNone(current) || current.value !== identity) {
                  yield* removeRejectedToken(input.expectedEnvironmentId, token.accessToken);
                  return yield* sessionChanged();
                }
                tokenOwners.set(input.expectedEnvironmentId, {
                  accessToken: token.accessToken,
                  identity,
                });
                if (pendingTokens.get(input.expectedEnvironmentId)?.id === id) {
                  pendingTokens.delete(input.expectedEnvironmentId);
                }
                return issued;
              }),
            ),
          ),
          Effect.timeoutOrElse({
            duration: DPOP_AUTHORIZATION_TIMEOUT_MS,
            orElse: () =>
              Effect.fail(
                new ConnectionTransientError({
                  reason: "timeout",
                  ...translatableDetail(msg("Timed out renewing the environment credential.")),
                }),
              ),
          }),
          Effect.ensuring(
            tokenLock.withPermits(1)(
              Effect.sync(() => {
                if (pendingTokens.get(input.expectedEnvironmentId)?.id === id) {
                  pendingTokens.delete(input.expectedEnvironmentId);
                }
              }),
            ),
          ),
          // One caller's timeout must not cancel renewal for other HTTP requests.
          Effect.forkIn(serviceScope),
        );
        const issued = Fiber.join(fiber);
        pendingTokens.set(input.expectedEnvironmentId, { id, identity, thumbprint, issued });
        return issued;
      }),
    );
    const issued = yield* staleEndpoint === undefined
      ? selected.pipe(Effect.catchTags({ DiscoveryUnavailable: ({ cause }) => Effect.fail(cause) }))
      : rediscoverOrVerifyCachedEndpoint(staleEndpoint, identity, selected);
    yield* Effect.annotateCurrentSpan({
      "connection.remote_token_cache": issued.source === "exchange" ? "miss" : "hit",
    });
    yield* assertSession(identity);
    return { ...issued, identity };
  });

  const proofError = (detail: string) => () =>
    new ConnectionBlockedError({ reason: "configuration", ...translatableDetail(detail) });

  // Requests for the same credential share a renewal without waiting on other hosts.
  const directDpopToken = Effect.fn("clientRuntime.connection.remote.directDpopToken")(function* (
    connection: DirectDpopConnection,
    rejectedAccessToken?: string,
  ) {
    return yield* directTokenLocks.withLock(
      connection.connectionId,
      Effect.gen(function* () {
        const stored = yield* credentials.get(connection.connectionId);
        if (Option.isNone(stored) || stored.value._tag !== "DpopConnectionCredential") {
          return yield* credentialMissingError(connection.connectionId);
        }
        const current = stored.value;
        const now = yield* Clock.currentTimeMillis;
        if (
          current.accessToken !== rejectedAccessToken &&
          current.expiresAtEpochMs - DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS > now
        ) {
          return current;
        }
        const proof = yield* signer
          .createProof({
            method: "POST",
            url: environmentEndpointUrl(connection.httpBaseUrl, "/oauth/token"),
          })
          .pipe(
            Effect.mapError(
              proofError(msg("Could not create the environment authorization proof.")),
            ),
          );
        const access = yield* exchangeRemoteDpopAccessToken({
          httpBaseUrl: connection.httpBaseUrl,
          credential: current.accessToken,
          credentialType: AuthAccessTokenType,
          dpopProof: proof,
        }).pipe(
          Effect.mapError((error) => mapRemoteDpopEnvironmentError(error, "direct")),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.withSpan("environment.authorization.directRenewal"),
        );
        const renewed = new DpopConnectionCredential({
          accessToken: access.access_token,
          expiresAtEpochMs: (yield* Clock.currentTimeMillis) + access.expires_in * 1_000,
        });
        yield* credentials.put(connection.connectionId, renewed);
        return renewed;
      }),
    );
  });

  const directHttpAuthorization = (
    connection: DirectDpopConnection,
    credential: DpopConnectionCredential,
  ) =>
    ({
      _tag: "Dpop",
      accessToken: credential.accessToken,
      expiresAtEpochMs: credential.expiresAtEpochMs,
      directConnection: connection,
    }) as const;

  const authorizeDirectDpop = Effect.fn("clientRuntime.connection.remote.authorizeDirectDpop")(
    function* (
      input: Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDirectDpop"]>[0],
    ) {
      const descriptor = yield* verifyDirectEndpoint({
        expectedEnvironmentId: input.expectedEnvironmentId,
        httpBaseUrl: input.httpBaseUrl,
        connectionMethod: "direct",
      });
      const connection = { connectionId: input.connectionId, httpBaseUrl: input.httpBaseUrl };
      const openSocket = (credential: DpopConnectionCredential) =>
        resolveRemoteDpopWebSocketConnectionUrl({
          wsBaseUrl: input.wsBaseUrl,
          httpBaseUrl: input.httpBaseUrl,
          accessToken: credential.accessToken,
          createProof: (proof) =>
            signer
              .createProof(proof)
              .pipe(
                Effect.mapError(
                  proofError(msg("Could not create the websocket authorization proof.")),
                ),
              ),
          clientMetadata: presentation.metadata,
          connectionMethod: "direct",
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.result);
      let credential = yield* directDpopToken(connection);
      let socket = yield* openSocket(credential);
      // A token the host refuses before its expiry, such as after a clock jump, renews once.
      if (Result.isFailure(socket) && socket.failure._tag === "EnvironmentAuthInvalidError") {
        credential = yield* directDpopToken(connection, credential.accessToken);
        socket = yield* openSocket(credential);
      }
      if (Result.isFailure(socket)) {
        const failure = socket.failure;
        return yield* failure._tag === "ConnectionBlockedError"
          ? failure
          : mapRemoteDpopEnvironmentError(failure, "direct");
      }
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        socketUrl: socket.success,
        descriptor,
        httpAuthorization: directHttpAuthorization(connection, credential),
      };
    },
  );

  const httpAuthorization = (
    token: TokenStore.RemoteDpopAccessToken,
    httpBaseUrl = token.endpoint.httpBaseUrl,
  ): AuthorizedRemoteHttpEnvironment => ({
    environmentId: token.environmentId,
    label: token.label,
    httpBaseUrl,
    httpAuthorization: {
      _tag: "Dpop",
      accessToken: token.accessToken,
      expiresAtEpochMs: token.expiresAtEpochMs,
    },
  });

  const authorizeDpop = Effect.fn("clientRuntime.connection.remote.authorizeDpop")(function* (
    input: Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDpop"]>[0],
  ) {
    const endpoint = input.directEndpoint;
    const via = endpoint === undefined ? "relay" : "direct";
    const directDescriptor =
      endpoint === undefined
        ? undefined
        : yield* verifyDirectEndpoint({
            expectedEnvironmentId: input.expectedEnvironmentId,
            httpBaseUrl: endpoint.httpBaseUrl,
            connectionMethod: "direct",
          });
    const authorized = (
      token: TokenStore.RemoteDpopAccessToken,
      socketUrl: string,
      descriptor: ExecutionEnvironmentDescriptor,
    ) => ({ ...httpAuthorization(token, endpoint?.httpBaseUrl), socketUrl, descriptor });
    let selected = yield* getDpopToken(input);
    const attemptScope = yield* Scope.Scope;
    const discovery = yield* Effect.cached(
      obtainBootstrap(input.expectedEnvironmentId, selected.identity),
    );
    const openSocket = Effect.fnUntraced(function* (issued: typeof selected, initial: boolean) {
      const cachedPublic = issued.source !== "exchange" && endpoint === undefined;
      const firstGateway = yield* Deferred.make<
        RemoteEnvironmentAuthError | ConnectionAttemptError
      >();
      const retryOnGateway = <A>(
        first: Effect.Effect<A, RemoteEnvironmentAuthError | ConnectionAttemptError>,
        retry = first,
      ) =>
        cachedPublic
          ? first.pipe(
              Effect.catchIf(isGatewayError, (gateway) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(firstGateway, gateway);
                  const current = yield* tokenStore.get(issued.token.environmentId);
                  yield* assertSession(issued.identity);
                  if (Option.isNone(current))
                    return yield* credentialMissingError(issued.token.environmentId);
                  if (
                    !matchesUsableToken(current.value, issued.token, yield* Clock.currentTimeMillis)
                  )
                    return yield* gateway;
                  return yield* retry;
                }),
              ),
            )
          : first;

      const timeout =
        initial && issued.source === "cache" ? CACHED_ENDPOINT_SOCKET_TIMEOUT_MS : undefined;
      const ticket = retryOnGateway(
        createDpopSocketUrl(issued.token, timeout, endpoint),
        createDpopSocketUrl(issued.token, undefined, endpoint),
      );
      const known = directDescriptor ?? issued.descriptor;
      const descriptor =
        known === undefined
          ? retryOnGateway(
              fetchRemoteEnvironmentDescriptor({
                httpBaseUrl: issued.token.endpoint.httpBaseUrl,
              }).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.mapError((error) =>
                  isEndpointUnavailable(error) ? error : mapRemoteEnvironmentError(error, via),
                ),
              ),
            )
          : Effect.succeed(known);
      const checked = descriptor.pipe(
        Effect.filterOrFail(
          (host) => host.environmentId === input.expectedEnvironmentId,
          (host) =>
            environmentMismatchError({
              expected: input.expectedEnvironmentId,
              actual: host.environmentId,
            }),
        ),
        Effect.map(Result.succeed),
        // An unexpected metadata response cannot explain a ticket failure on the same route.
        Effect.catchIf(
          (error) =>
            error._tag === "ConnectionTransientError" &&
            error.reason === "remote-unavailable" &&
            error.httpStatus !== 401 &&
            error.httpStatus !== 403 &&
            error.httpStatus !== 407,
          (error) => Effect.succeed(Result.fail(error)),
        ),
      );
      const ready = Effect.all([ticket, checked], { concurrency: "unbounded" }).pipe(
        Effect.flatMap(([socketUrl, reading]) =>
          Result.isSuccess(reading)
            ? Effect.succeed(authorized(issued.token, socketUrl, reading.success))
            : Effect.fail(reading.failure),
        ),
        Effect.result,
      );
      if (!initial || !cachedPublic) return yield* ready;

      const endpointChanged = Effect.gen(function* () {
        const gateway = yield* Deferred.await(firstGateway);
        yield* Effect.sleep(CACHED_ENDPOINT_SOCKET_TIMEOUT_MS);
        // Renewal can join this lookup when the old handshake fails before discovery finishes.
        const lookup = yield* discovery.pipe(Effect.result, Effect.forkIn(attemptScope));
        const result = yield* Fiber.join(lookup);
        if (Result.isFailure(result)) {
          if (!isDiscoveryUnavailable(result.failure)) return yield* result.failure;
        } else if (
          result.success.endpoint.httpBaseUrl !== issued.token.endpoint.httpBaseUrl ||
          result.success.endpoint.wsBaseUrl !== issued.token.endpoint.wsBaseUrl
        )
          return Result.fail(gateway);
        return yield* Effect.never;
      });
      return yield* Effect.raceFirst(ready, endpointChanged).pipe(
        Effect.tapError(() =>
          assertSession(issued.identity).pipe(
            Effect.andThen(markEndpointStale(issued.token)),
            Effect.ignore,
          ),
        ),
      );
    });

    let socket = yield* openSocket(selected, true);
    if (selected.source !== "exchange" && Result.isFailure(socket)) {
      const failure = socket.failure;
      if (
        failure._tag === "ConnectionBlockedError" ||
        failure._tag === "ConnectionTransientError"
      ) {
        return yield* failure;
      }
      // An unreachable direct address says nothing about the token, so keep
      // it for the T3 Connect route rather than forcing a relay round trip.
      if (endpoint !== undefined && failure._tag !== "EnvironmentAuthInvalidError") {
        return yield* mapDpopSocketError(failure, via);
      }
      yield* assertSession(selected.identity);
      // A gateway failure can make the endpoint stale while the credential still works over LAN.
      if (isEndpointUnavailable(failure)) {
        yield* markEndpointStale(selected.token);
        selected = yield* getDpopToken(input, selected.identity, discovery);
      } else {
        selected = yield* getDpopToken(
          {
            ...input,
            rejectedAccessToken: selected.token.accessToken,
          },
          selected.identity,
          discovery,
        );
      }
      socket = yield* openSocket(selected, false);
    }
    if (Result.isFailure(socket)) {
      if (endpoint === undefined && isEndpointUnavailable(socket.failure)) {
        yield* markEndpointStale(selected.token);
      } else if (endpoint === undefined && socket.failure._tag === "EnvironmentAuthInvalidError") {
        yield* tokenLock.withPermits(1)(
          removeRejectedToken(input.expectedEnvironmentId, selected.token.accessToken),
        );
      }
      return yield* mapDpopSocketError(socket.failure, via);
    }
    yield* assertSession(selected.identity);
    if (endpoint === undefined && selected.token.endpointNeedsDiscovery) {
      const { endpointNeedsDiscovery: _stale, ...verified } = selected.token;
      // A confirmed ticket is usable even if persisting this cache hint fails.
      yield* tokenStore
        .put(new TokenStore.RemoteDpopAccessToken(verified), verified.accessToken)
        .pipe(Effect.ignore);
      yield* assertSession(selected.identity);
    }
    return socket.success;
  }, Effect.scoped);

  return RemoteEnvironmentAuthorization.of({
    authorizeBearer,
    // Untraced: it runs on every route and host check.
    rememberCheckedDescriptor: Effect.fnUntraced(function* (httpBaseUrl, descriptor, keepsItsHost) {
      if (Option.isNone(descriptor) || !keepsItsHost) {
        checkedDescriptors.delete(httpBaseUrl);
        return;
      }
      checkedDescriptors.set(httpBaseUrl, {
        descriptor: descriptor.value,
        at: yield* Clock.monotonicTimeNanos,
      });
    }),
    authorizeDpop: Effect.fn("environment.authorization")(function (input) {
      return authorizeDpop(input);
    }),
    authorizeDirectDpop,
    authorizeDirectDpopHttp: Effect.fn("environment.authorization.directHttp")(
      function* (connection, rejectedAccessToken) {
        const credential = yield* directDpopToken(connection, rejectedAccessToken);
        return directHttpAuthorization(connection, credential);
      },
    ),
    // The relay tracer must wrap span creation, not just the token request.
    authorizeDpopHttp: Effect.fnUntraced(function* (input) {
      return yield* getDpopToken(input).pipe(
        Effect.map(({ token }) => httpAuthorization(token, input.directEndpoint?.httpBaseUrl)),
        Effect.withSpan("environment.authorization.http"),
        withRelayClientTracing,
      );
    }),
    // Untraced: a span here would stay open for the socket's lifetime. Each renewal has its own.
    renewDpopBeforeExpiry: Effect.fnUntraced(function* (input) {
      const direct = input.directConnection;
      let expiresAtEpochMs = input.expiresAtEpochMs;
      let now = yield* Clock.currentTimeMillis;
      // Past expiry the server has closed a T3 Connect socket. A direct socket stays open for
      // its session's whole renewal window, so it keeps retrying until a blocked credential.
      while (direct !== undefined || now < expiresAtEpochMs) {
        // getDpopToken reuses a cached token until it is within the skew of expiry.
        // The floor spaces out retries and keeps a wall-clock jump from spinning.
        const floor = now < expiresAtEpochMs ? 5_000 : DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS;
        yield* Effect.sleep(
          Math.max(floor, expiresAtEpochMs - DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS - now),
        );
        const renewed = yield* (
          direct === undefined
            ? getDpopToken({ expectedEnvironmentId: input.expectedEnvironmentId }).pipe(
                Effect.map(({ token }) => token.expiresAtEpochMs),
              )
            : directDpopToken(direct).pipe(Effect.map((credential) => credential.expiresAtEpochMs))
        ).pipe(
          Effect.withSpan("environment.authorization.renewSocket"),
          withRelayClientTracing,
          // A relay blip retries until expiry; a blocked credential ends the loop.
          Effect.catchTags({ ConnectionTransientError: () => Effect.succeed(expiresAtEpochMs) }),
        );
        expiresAtEpochMs = Math.max(expiresAtEpochMs, renewed);
        now = yield* Clock.currentTimeMillis;
      }
    }),
  });
});

export const layer = Layer.effect(RemoteEnvironmentAuthorization, make);

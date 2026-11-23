import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
  RemoteEnvironmentAuthUndeclaredStatusError,
  type RemoteEnvironmentAuthError,
} from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  EnvironmentAuthInvalidError,
  DesktopDiscoveredSshHostSchema,
  DesktopSshBearerBootstrapInputSchema,
  DesktopSshBearerRequestInputSchema,
  DesktopSshEnvironmentEnsureInputSchema,
  DesktopSshEnvironmentEnsureResultSchema,
  DesktopSshEnvironmentTargetSchema,
  type DesktopSshEnvironmentTarget,
  type DesktopSshInstallProgress,
  DesktopSshHttpBaseUrlInputSchema,
  DesktopSshPasswordPromptCancelledType,
  DesktopSshPasswordPromptResolutionInputSchema,
  ExecutionEnvironmentDescriptor,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  AuthAccessTokenResult,
  AuthSessionState,
} from "@t3tools/contracts";
import { SshHttpBridgeError } from "@t3tools/ssh/errors";
import { resolveLoopbackSshHttpBaseUrl } from "@t3tools/ssh/tunnel";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as DesktopSshEnvironment from "../../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../../ssh/DesktopSshPasswordPrompts.ts";

const DesktopSshEnvironmentRequestOperation = Schema.Literals([
  "fetch-environment-descriptor",
  "bootstrap-bearer-session",
  "fetch-session-state",
]);
type DesktopSshEnvironmentRequestOperation = typeof DesktopSshEnvironmentRequestOperation.Type;

type DesktopSshEnvironmentRequestCause = RemoteEnvironmentAuthError | SshHttpBridgeError;

const isEnvironmentAuthInvalidError = Schema.is(EnvironmentAuthInvalidError);
const isEnvironmentInternalError = Schema.is(EnvironmentInternalError);
const isEnvironmentOperationForbiddenError = Schema.is(EnvironmentOperationForbiddenError);
const isEnvironmentRequestInvalidError = Schema.is(EnvironmentRequestInvalidError);
const isEnvironmentScopeRequiredError = Schema.is(EnvironmentScopeRequiredError);
const isRemoteEnvironmentAuthUndeclaredStatusError = Schema.is(
  RemoteEnvironmentAuthUndeclaredStatusError,
);
const isSshHttpBridgeError = Schema.is(SshHttpBridgeError);

function readSshHttpStatus(cause: DesktopSshEnvironmentRequestCause): number | null {
  if (isRemoteEnvironmentAuthUndeclaredStatusError(cause) || isSshHttpBridgeError(cause)) {
    return cause.status ?? null;
  }
  if (isEnvironmentRequestInvalidError(cause)) {
    return 400;
  }
  if (isEnvironmentAuthInvalidError(cause)) {
    return 401;
  }
  if (isEnvironmentScopeRequiredError(cause)) {
    return 403;
  }
  if (isEnvironmentOperationForbiddenError(cause)) {
    return 403;
  }
  if (isEnvironmentInternalError(cause)) {
    return 500;
  }
  return null;
}

export class DesktopSshEnvironmentRequestError extends Schema.TaggedError<
  DesktopSshEnvironmentRequestError,
  { readonly brand: unique symbol }
>()("DesktopSshEnvironmentRequestError", {
  operation: DesktopSshEnvironmentRequestOperation,
  cause: Schema.Defect(),
  sshHttpStatus: Schema.NullOr(Schema.Number),
}) {
  // The web client matches "[ssh_http:500]" to explain version-skewed SSH pairing.
  override get message() {
    const prefix = this.sshHttpStatus === null ? "" : `[ssh_http:${this.sshHttpStatus}] `;
    return `${prefix}SSH remote API request failed during ${this.operation}.`;
  }
}

const withLoopbackSshApi =
  <A, R>(
    operation: DesktopSshEnvironmentRequestOperation,
    use: (httpBaseUrl: string) => Effect.Effect<A, RemoteEnvironmentAuthError, R>,
  ) =>
  (httpBaseUrl: string): Effect.Effect<A, DesktopSshEnvironmentRequestError, R> =>
    resolveLoopbackSshHttpBaseUrl(httpBaseUrl).pipe(
      Effect.flatMap(use),
      Effect.mapError(
        (cause) =>
          new DesktopSshEnvironmentRequestError({
            operation,
            cause,
            sshHttpStatus: readSshHttpStatus(cause),
          }),
      ),
    );

export const discoverSshHosts = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCOVER_SSH_HOSTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopDiscoveredSshHostSchema),
  handler: Effect.fn("desktop.ipc.sshEnvironment.discoverHosts")(function* () {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    return yield* sshEnvironment.discoverHosts();
  }),
});

export const resolveSshHost = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESOLVE_SSH_HOST_CHANNEL,
  payload: Schema.String,
  result: DesktopSshEnvironmentTargetSchema,
  handler: Effect.fn("desktop.ipc.sshEnvironment.resolveHost")(function* (alias) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    return yield* sshEnvironment.resolveHost(alias);
  }),
});

const pendingSshInstalls = new Map<string, Set<Deferred.Deferred<void>>>();

function sshInstallKey(
  target: DesktopSshEnvironmentTarget,
  event?: DesktopIpc.DesktopIpcInvokeEvent,
) {
  return JSON.stringify([
    event?.sender.id,
    target.alias,
    target.hostname,
    target.username,
    target.port,
  ]);
}

export const ensureSshEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL,
  payload: DesktopSshEnvironmentEnsureInputSchema,
  result: DesktopSshEnvironmentEnsureResultSchema,
  handler: Effect.fn("desktop.ipc.sshEnvironment.ensureEnvironment")(function* (
    { target, options },
    event,
  ) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    const key = sshInstallKey(target, event);
    const reportInstallProgress = (progress: DesktopSshInstallProgress) => {
      const sender = event?.sender;
      if (sender?.isDestroyed?.() === false) {
        sender.send?.(IpcChannels.SSH_INSTALL_PROGRESS_CHANNEL, target, progress);
      }
    };
    return yield* Effect.acquireUseRelease(
      Deferred.make<void>().pipe(
        Effect.tap((cancel) =>
          Effect.sync(() => {
            const pending = pendingSshInstalls.get(key) ?? new Set();
            pending.add(cancel);
            pendingSshInstalls.set(key, pending);
          }),
        ),
      ),
      (cancel) =>
        sshEnvironment.ensureEnvironment(target, { ...options, reportInstallProgress }).pipe(
          Effect.catchIf(DesktopSshEnvironment.isDesktopSshPasswordPromptCancellation, (error) =>
            Effect.succeed({ type: DesktopSshPasswordPromptCancelledType, message: error.message }),
          ),
          Effect.raceFirst(
            Deferred.await(cancel).pipe(
              Effect.as({
                type: DesktopSshPasswordPromptCancelledType,
                message: "SSH installation cancelled.",
              }),
            ),
          ),
        ),
      (cancel) =>
        Effect.sync(() => {
          const pending = pendingSshInstalls.get(key);
          pending?.delete(cancel);
          if (pending?.size === 0) {
            pendingSshInstalls.delete(key);
            reportInstallProgress({ phase: "finished" });
          }
        }),
    );
  }),
});

export const disconnectSshEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCONNECT_SSH_ENVIRONMENT_CHANNEL,
  payload: DesktopSshEnvironmentTargetSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sshEnvironment.disconnectEnvironment")(function* (target, event) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    for (const cancel of pendingSshInstalls.get(sshInstallKey(target, event)) ?? []) {
      yield* Deferred.succeed(cancel, undefined);
    }
    yield* sshEnvironment.disconnectEnvironment(target);
  }),
});

export const fetchSshEnvironmentDescriptor = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL,
  payload: DesktopSshHttpBaseUrlInputSchema,
  result: ExecutionEnvironmentDescriptor,
  handler: Effect.fn("desktop.ipc.sshEnvironment.fetchDescriptor")(function* ({ httpBaseUrl }) {
    return yield* withLoopbackSshApi("fetch-environment-descriptor", (resolvedHttpBaseUrl) =>
      fetchRemoteEnvironmentDescriptor({ httpBaseUrl: resolvedHttpBaseUrl }),
    )(httpBaseUrl);
  }),
});

export const bootstrapSshBearerSession = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL,
  payload: DesktopSshBearerBootstrapInputSchema,
  result: AuthAccessTokenResult,
  handler: Effect.fn("desktop.ipc.sshEnvironment.bootstrapBearerSession")(function* ({
    httpBaseUrl,
    credential,
  }) {
    return yield* withLoopbackSshApi("bootstrap-bearer-session", (resolvedHttpBaseUrl) =>
      bootstrapRemoteBearerSession({
        httpBaseUrl: resolvedHttpBaseUrl,
        credential,
      }),
    )(httpBaseUrl);
  }),
});

export const fetchSshSessionState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FETCH_SSH_SESSION_STATE_CHANNEL,
  payload: DesktopSshBearerRequestInputSchema,
  result: AuthSessionState,
  handler: Effect.fn("desktop.ipc.sshEnvironment.fetchSessionState")(function* ({
    httpBaseUrl,
    bearerToken,
  }) {
    return yield* withLoopbackSshApi("fetch-session-state", (resolvedHttpBaseUrl) =>
      fetchRemoteSessionState({
        httpBaseUrl: resolvedHttpBaseUrl,
        bearerToken,
      }),
    )(httpBaseUrl);
  }),
});

export const resolveSshPasswordPrompt = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL,
  payload: DesktopSshPasswordPromptResolutionInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sshEnvironment.resolvePasswordPrompt")(function* ({
    requestId,
    password,
  }) {
    const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
    yield* prompts.resolve({ requestId, password });
  }),
});

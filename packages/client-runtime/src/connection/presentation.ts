import { translateUi, type UiTranslator } from "@t3tools/shared/uiLocale";
import type { ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { mFallback } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { type MarkedText, resolveMarkedText } from "../errors/translatable.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import type { ConnectionTarget, SupervisorConnectionState } from "./model.ts";
import { connectionRouteId, connectionRoutes, routeHttpBaseUrl } from "./routes.ts";

export type EnvironmentConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error"
  | "unsupported";

export interface EnvironmentConnectionPresentation {
  readonly phase: EnvironmentConnectionPhase;
  readonly error: string | null;
  /** `error` as marked text, when the failure carries it. Read both through `connectionErrorText`. */
  readonly i18nError?: MarkedText;
  readonly traceId: string | null;
  /**
   * Set while reconnecting because the host has not approved this device yet. `error` then
   * says where to approve it and shows the code, and is not a failure.
   */
  readonly awaitingApproval?: true;
  readonly verificationCode?: string;
}

/**
 * Provider statuses are pushed every few minutes with fresh `checkedAt` stamps, and every root
 * coordinator reads environment presentations. Leaving them out keeps a presentation stable
 * across those pushes; provider readers subscribe to the server's providers atom instead.
 */
export type EnvironmentServerConfig = Omit<ServerConfig, "providers">;

export interface EnvironmentPresentation {
  readonly entry: ConnectionCatalogEntry;
  readonly connection: EnvironmentConnectionPresentation;
  readonly serverConfig: EnvironmentServerConfig | null;
  /** See `SupervisorConnectionState.refusedRouteIds`. */
  readonly refusedRouteIds: ReadonlyArray<string>;
}

function failureError(
  failure: SupervisorConnectionState["lastFailure"],
): Pick<EnvironmentConnectionPresentation, "error" | "i18nError" | "traceId"> {
  return {
    error: failure?.message ?? null,
    ...(failure?.i18nMessage !== undefined ? { i18nError: failure.i18nMessage } : {}),
    traceId: failure?.traceId ?? null,
  };
}

export function presentConnectionState(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  if (
    (state.phase === "connecting" || state.phase === "backoff") &&
    state.lastFailure?.reason === "approval-pending"
  ) {
    return {
      phase: "reconnecting",
      ...failureError(state.lastFailure),
      awaitingApproval: true,
      ...(state.lastFailure.verificationCode
        ? { verificationCode: state.lastFailure.verificationCode }
        : {}),
    };
  }
  switch (state.phase) {
    case "available":
      return { phase: "available", error: null, traceId: null };
    case "offline":
      return { phase: "offline", error: null, traceId: null };
    case "connecting":
      return {
        phase: state.attempt <= 1 && state.lastFailure === null ? "connecting" : "reconnecting",
        ...failureError(state.lastFailure),
      };
    case "connected":
      return { phase: "connected", error: null, traceId: null };
    case "backoff":
      return {
        phase: "reconnecting",
        ...failureError(state.lastFailure),
      };
    case "blocked":
      return {
        phase: state.lastFailure?.reason === "unsupported" ? "unsupported" : "error",
        ...failureError(state.lastFailure),
      };
  }
}

/** The connection's error in the active language, or null when it has none. */
export function connectionErrorText(
  connection: Pick<EnvironmentConnectionPresentation, "error" | "i18nError">,
  resolve: MFunctionType = mFallback,
): string | null {
  if (connection.error === null) return null;
  return connection.i18nError !== undefined
    ? resolveMarkedText(connection.i18nError, resolve)
    : connection.error;
}

export function connectionStatusText(
  connection: EnvironmentConnectionPresentation,
  t: UiTranslator = translateUi.bind(null, "en"),
  resolve: MFunctionType = mFallback,
): string {
  const error = connectionErrorText(connection, resolve);
  switch (connection.phase) {
    case "available":
      return t("Available");
    case "offline":
      return t("Offline");
    case "connecting":
      return t("Connecting...");
    case "reconnecting":
      if (connection.awaitingApproval) {
        return connection.verificationCode
          ? t("Waiting for approval on the host. Code: {code}", {
              code: connection.verificationCode,
            })
          : t("Waiting for approval on the host");
      }
      return error
        ? t("Failed to connect. Reconnecting... Reason: {error}", { error })
        : t("Reconnecting...");
    case "connected":
      return t("Connected");
    case "unsupported":
      return t("Client not supported");
    case "error":
      return error ? t("Connection failed. Reason: {error}", { error }) : t("Connection failed");
  }
}

export function connectionStatusTitle(
  connection: EnvironmentConnectionPresentation,
  t: UiTranslator = translateUi.bind(null, "en"),
): string {
  if (connection.awaitingApproval) {
    return t("Waiting for approval");
  }
  if (connection.phase === "reconnecting" && connection.error) {
    return t("Failed to connect. Reconnecting...");
  }
  return connectionStatusText({ ...connection, error: null }, t);
}

/**
 * The T3 Connect address wins whenever it is known: it works for agents anywhere, while the
 * connected route is often a LAN or loopback address. SSH routes ride a local forward that
 * disappears with the client, so they have no stable address.
 */
export function environmentMcpUrl(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly relayHttpBaseUrl?: string | undefined;
  readonly connectedTarget?: ConnectionTarget | null | undefined;
}): string | null {
  const relayMcpUrl = input.relayHttpBaseUrl ? mcpUrlFromBase(input.relayHttpBaseUrl) : null;
  if (relayMcpUrl !== null) return relayMcpUrl;
  const connectedRouteId = input.connectedTarget ? connectionRouteId(input.connectedTarget) : null;
  const routes = connectionRoutes(input.entry);
  const connectedRoute = routes.find(
    (route) => connectionRouteId(route.target) === connectedRouteId,
  );
  for (const route of connectedRoute ? [connectedRoute, ...routes] : routes) {
    const httpBaseUrl = routeHttpBaseUrl(route);
    const mcpUrl = httpBaseUrl === null ? null : mcpUrlFromBase(httpBaseUrl);
    if (mcpUrl !== null) return mcpUrl;
  }
  return null;
}

function mcpUrlFromBase(httpBaseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(httpBaseUrl);
  } catch {
    return null;
  }
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function connectionCatalogDisplayUrl(entry: ConnectionCatalogEntry): string | null {
  switch (entry.target._tag) {
    case "PrimaryConnectionTarget":
      return entry.target.httpBaseUrl;
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "BearerConnectionProfile"
        ? entry.profile.value.httpBaseUrl
        : null;
    case "SshConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "SshConnectionProfile"
        ? `${entry.profile.value.target.username}@${entry.profile.value.target.hostname}`
        : null;
  }
}

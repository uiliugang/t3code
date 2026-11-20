import { translateUi, type UiTranslator } from "@t3tools/shared/uiLocale";
import {
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";

import { m, type MessageResolver } from "~/i18n/messages";

export interface SavedCloudEnvironmentConnectionPresentation {
  readonly buttonLabel: string;
  readonly statusText: string;
  readonly tone: "connected" | "connecting" | "error" | "idle";
}

export function presentSavedCloudEnvironmentConnection(
  connection: EnvironmentConnectionPresentation,
  t: UiTranslator = translateUi.bind(null, "en"),
  resolve: MessageResolver = m,
): SavedCloudEnvironmentConnectionPresentation {
  switch (connection.phase) {
    case "connected":
      return {
        buttonLabel: t("Connected"),
        statusText: connectionStatusText(connection, t, resolve),
        tone: "connected",
      };
    case "connecting":
      return {
        buttonLabel: t("Connecting…"),
        statusText: connectionStatusText(connection, t, resolve),
        tone: "connecting",
      };
    case "reconnecting":
      return {
        buttonLabel: t(connection.awaitingApproval ? "Waiting for approval…" : "Reconnecting…"),
        statusText: connectionStatusText(connection, t, resolve),
        tone: "connecting",
      };
    case "unsupported":
      return {
        buttonLabel: t("Client not supported"),
        statusText: connectionStatusText(connection, t, resolve),
        tone: "idle",
      };
    case "error":
      return {
        buttonLabel: t("Connection failed"),
        statusText: connectionStatusText(connection, t, resolve),
        tone: "error",
      };
    case "offline":
      return {
        buttonLabel: t("Offline"),
        statusText: connectionStatusText(connection, t, resolve),
        tone: "idle",
      };
    case "available":
      return {
        buttonLabel: t("Not connected"),
        statusText: connectionStatusText(connection, t, resolve),
        tone: "idle",
      };
  }
}

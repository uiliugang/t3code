import {
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import type { UiTranslator } from "@t3tools/shared/uiLocale";

export function environmentStatusText(
  connection: EnvironmentConnectionPresentation,
  t: UiTranslator,
): string {
  return connection.phase === "unsupported" && connection.error !== null
    ? t(connection.error)
    : connectionStatusText(connection, t);
}

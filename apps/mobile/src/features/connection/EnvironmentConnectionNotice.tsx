import { Button } from "../../components/ui/Button";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { ConnectionTraceId } from "./ConnectionTraceId";
import {
  connectionStatusText,
  type EnvironmentConnectionPhase,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import { SymbolView } from "../../components/ui/AppSymbol";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useUiTranslation } from "../../lib/useUiTranslation";

function noticeTitle(
  phase: EnvironmentConnectionPhase,
  environmentLabel: string,
  awaitingApproval: boolean,
  t: ReturnType<typeof useUiTranslation>,
): string {
  if (awaitingApproval)
    return t("Waiting for {environment} to approve this device", { environment: environmentLabel });
  switch (phase) {
    case "offline":
      return t("You are offline");
    case "connecting":
      return t("Connecting to {environment}...", { environment: environmentLabel });
    case "reconnecting":
      return t("Reconnecting to {environment}...", { environment: environmentLabel });
    case "unsupported":
      return t("Client not supported");
    case "error":
      return t("{environment} is unavailable", { environment: environmentLabel });
    case "available":
      return t("{environment} is disconnected", { environment: environmentLabel });
    case "connected":
      return "";
  }
}

function noticeDetail(
  connection: EnvironmentConnectionPresentation,
  resourceName: string,
  t: ReturnType<typeof useUiTranslation>,
): string {
  const { phase, error } = connection;
  if (connection.awaitingApproval) return connectionStatusText(connection, t);
  if (error) {
    return phase === "reconnecting"
      ? t("The app will keep retrying automatically. {error}", { error: t(error) })
      : t(error);
  }

  switch (phase) {
    case "offline":
      return t(
        "Cached data remains available. The {resource} will load when your connection returns.",
        { resource: t(resourceName) },
      );
    case "connecting":
    case "reconnecting":
      return t("The {resource} will load as soon as the environment is ready.", {
        resource: t(resourceName),
      });
    case "unsupported":
      return t("Use compatible versions of the app and server to connect.");
    case "available":
    case "error":
      return t("Reconnect the environment to load the {resource}.", { resource: t(resourceName) });
    case "connected":
      return "";
  }
}

export function EnvironmentConnectionNotice(props: {
  readonly environmentLabel: string;
  readonly connection: EnvironmentConnectionPresentation;
  readonly resourceName: string;
  readonly onRetry: () => void;
}) {
  const t = useUiTranslation();
  const isRetrying =
    props.connection.phase === "connecting" || props.connection.phase === "reconnecting";

  return (
    <View className="flex-1 items-center justify-center px-8">
      <View className="max-w-[320px] items-center gap-3">
        {isRetrying ? (
          <AppActivityIndicator size="small" colorClassName={"accent-icon-muted"} />
        ) : (
          <SymbolView
            name={props.connection.phase === "offline" ? "wifi.slash" : "bolt.horizontal.circle"}
            size={24}
            tintColorClassName={"accent-icon-muted"}
            type="monochrome"
          />
        )}

        <Text className="text-center text-lg font-t3-bold text-foreground">
          {noticeTitle(
            props.connection.phase,
            props.environmentLabel,
            props.connection.awaitingApproval === true,
            t,
          )}
        </Text>
        <Text className="text-center text-sm leading-normal text-foreground-muted">
          {noticeDetail(props.connection, props.resourceName, t)}
          {props.connection.traceId ? (
            <ConnectionTraceId traceId={props.connection.traceId} />
          ) : null}
        </Text>

        {props.connection.phase !== "offline" && props.connection.phase !== "unsupported" ? (
          <View className="mt-1">
            <Button label={t("Retry now")} tone="secondary" onPress={props.onRetry} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

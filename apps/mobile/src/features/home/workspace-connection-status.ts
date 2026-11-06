import type { WorkspaceState } from "../../state/workspaceModel";
import { translateUi, type UiTranslator } from "@t3tools/shared/uiLocale";

export interface WorkspaceConnectionStatusPresentation {
  readonly label: string;
  readonly showsProgress: boolean;
}

function shouldShowWorkspaceConnectionStatus(state: WorkspaceState): boolean {
  if (state.networkStatus === "offline") return true;
  if (state.hasReadyEnvironment) return state.hasSyncingConnectedEnvironment;
  return (
    state.connectionError !== null ||
    state.hasConnectingEnvironment ||
    state.hasPendingShellSnapshot ||
    (state.hasLoadedShellSnapshot && !state.hasReadyEnvironment)
  );
}

function workspaceConnectionStatusLabel(state: WorkspaceState, t: UiTranslator): string {
  if (state.networkStatus === "offline") return t("You are offline");
  if (state.hasReadyEnvironment && state.hasSyncingConnectedEnvironment) {
    return state.hasLoadedShellSnapshot ? t("Syncing threads...") : t("Loading threads...");
  }
  if (state.connectingEnvironments.length === 1) {
    return t("Reconnecting to {environment}", {
      environment: state.connectingEnvironments[0]!.environmentLabel,
    });
  }
  if (state.connectingEnvironments.length > 1) {
    return t("Reconnecting {count} environments", { count: state.connectingEnvironments.length });
  }
  if (state.connectionError !== null) return state.connectionError;
  if (state.hasPendingShellSnapshot) {
    return state.hasLoadedShellSnapshot ? t("Syncing threads...") : t("Loading threads...");
  }
  return t("Not connected");
}

export function workspaceConnectionStatusPresentation(
  state: WorkspaceState,
  t: UiTranslator = (message, values) => translateUi("en", message, values),
): WorkspaceConnectionStatusPresentation | null {
  if (!shouldShowWorkspaceConnectionStatus(state)) return null;
  return {
    label: workspaceConnectionStatusLabel(state, t),
    showsProgress:
      state.networkStatus !== "offline" &&
      (state.hasReadyEnvironment || state.connectionError === null) &&
      (state.connectingEnvironments.length > 0 || state.hasPendingShellSnapshot),
  };
}

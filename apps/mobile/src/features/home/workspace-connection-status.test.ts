import { describe, expect, it } from "vite-plus/test";
import { decodeOptions, gtFallback } from "gt-react-native";
import { translateUi } from "@t3tools/shared/uiLocale";

import type { MessageResolver } from "../../i18n/messages";
import zh from "../../i18n/translations/zh.json";

import type { WorkspaceState } from "../../state/workspaceModel";
import { workspaceConnectionStatusPresentation } from "./workspace-connection-status";

function workspaceState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    isLoadingConnections: false,
    hasConnections: true,
    hasLoadedShellSnapshot: true,
    hasPendingShellSnapshot: false,
    hasSyncingConnectedEnvironment: false,
    hasReadyEnvironment: true,
    hasConnectingEnvironment: false,
    connectingEnvironments: [],
    connectionState: "connected",
    connectionError: null,
    shellSnapshotError: null,
    networkStatus: "online",
    ...overrides,
  };
}

describe("workspace connection status", () => {
  it.each([
    ["reconnecting", "Could not reach sleeping laptop"],
    ["error", "Could not reach sleeping laptop"],
  ] as const)(
    "keeps the brand while a secondary environment is %s (%s)",
    (connectionState, connectionError) => {
      const state = workspaceState({
        hasConnectingEnvironment: connectionState !== "error",
        hasPendingShellSnapshot: true,
        connectionError,
        connectingEnvironments:
          connectionState === "error"
            ? []
            : [
                {
                  environmentId: "environment-2" as never,
                  environmentLabel: "Sleeping laptop",
                  displayUrl: "",
                  isRelayManaged: false,
                  isEnabled: true,
                  connectionState,
                  connectionError,
                  connectionErrorTraceId: null,
                },
              ],
      });

      expect(workspaceConnectionStatusPresentation(state)).toBeNull();
    },
  );

  it("shows connected shell catch-up even while a secondary environment is unreachable", () => {
    const t = ((message: string) => {
      const options = decodeOptions(message);
      const source = typeof options?.$_source === "string" ? options.$_source : message;
      const translated = source.startsWith("{count, plural, one {Reconnecting ")
        ? zh["1a75f83e4b8bb3ed"]
        : translateUi("zh-CN", source);
      return gtFallback(translated, { ...options, $locale: "zh" });
    }) as MessageResolver;
    const state = workspaceState({
      hasSyncingConnectedEnvironment: true,
      hasPendingShellSnapshot: true,
      hasConnectingEnvironment: true,
      connectionError: "Could not reach sleeping laptop",
      connectingEnvironments: [
        {
          environmentId: "environment-2" as never,
          environmentLabel: "Sleeping laptop",
          displayUrl: "",
          isRelayManaged: false,
          isEnabled: true,
          connectionState: "reconnecting",
          connectionError: "Could not reach sleeping laptop",
          connectionErrorTraceId: null,
        },
      ],
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Syncing threads...",
      showsProgress: true,
    });
    expect(workspaceConnectionStatusPresentation(state, t)).toEqual({
      label: "正在同步对话…",
      showsProgress: true,
    });
    const reconnecting = workspaceState({
      ...state,
      hasReadyEnvironment: false,
      hasSyncingConnectedEnvironment: false,
      connectionError: null,
      connectingEnvironments: state.connectingEnvironments.map((environment) => ({
        ...environment,
        environmentLabel: "Gmac {environment}",
      })),
    });
    expect(workspaceConnectionStatusPresentation(reconnecting, t)).toEqual({
      label: "正在重新连接 Gmac {environment}",
      showsProgress: true,
    });
    expect(
      workspaceConnectionStatusPresentation(
        {
          ...reconnecting,
          connectingEnvironments: [
            ...reconnecting.connectingEnvironments,
            ...reconnecting.connectingEnvironments,
          ],
        },
        t,
      )?.label,
    ).toBe("正在重新连接 2 个环境");
    expect(
      workspaceConnectionStatusPresentation(
        {
          ...reconnecting,
          connectingEnvironments: [],
          connectionError: "Syncing threads...",
        },
        t,
      )?.label,
    ).toBe("Syncing threads...");
    expect(
      workspaceConnectionStatusPresentation(
        {
          ...reconnecting,
          connectingEnvironments: [],
          connectionError: null,
          hasLoadedShellSnapshot: false,
        },
        t,
      )?.label,
    ).toBe("正在加载对话…");
  });
});

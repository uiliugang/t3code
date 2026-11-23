import { View } from "react-native";
import { IconButton } from "../../../components/ui/IconButton";
import { useUiTranslation } from "../../../lib/useUiTranslation";
import { useWorkspaceConnectionState } from "../../../state/workspace";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { NAVIGATION_TAB_ICONS, useEnabledNavigationTabs } from "./navigation-tabs";

export function AndroidSidebarPinnedTabs(props: { readonly onNewThread: () => void }) {
  const tabs = useEnabledNavigationTabs();
  const state = useWorkspaceTabs()?.state;
  const { hasConnections } = useWorkspaceConnectionState();
  const select = useSelectWorkspaceTab();
  const t = useUiTranslation();
  return (
    <View className="w-full flex-row flex-wrap items-center justify-between bg-header px-1">
      {tabs.map((tab) => (
        <IconButton
          key={tab}
          icon={NAVIGATION_TAB_ICONS[tab]}
          accessibilityLabel={
            tab === "threads"
              ? t("Chats")
              : tab === "requirements"
                ? t("Requirements board")
                : tab === "pullRequests"
                  ? t("Pull requests")
                  : tab === "issues"
                    ? t("Issues")
                    : t("Usage")
          }
          selected={state?.selectedTab === tab}
          variant={state?.selectedTab === tab ? "tonal" : "standard"}
          onPress={() => select(tab)}
        />
      ))}
      <IconButton
        accessibilityLabel={t("Settings")}
        icon="gearshape"
        onPress={() => select("settings")}
      />
      <IconButton
        accessibilityLabel={t("New thread")}
        icon="square.and.pencil"
        variant="primary"
        disabled={!hasConnections}
        onPress={props.onNewThread}
      />
    </View>
  );
}

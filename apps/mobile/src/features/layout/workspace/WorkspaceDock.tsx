import { Keyboard, Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { Menu } from "../../../components/ui/Menu";
import { GlassSurface } from "../../../components/ui/GlassSurface";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WORKSPACE_DOCK } from "./workspace-tabs-state";
import { PullRequestGlyph } from "../../pull-requests/pullRequestGlyphs";
import { useNavigation } from "@react-navigation/native";
import { useUiTranslation } from "../../../lib/useUiTranslation";

export function WorkspaceDock(props: { readonly onNewTask: () => void }) {
  const t = useUiTranslation();
  const workspace = useWorkspaceTabs()!;
  const navigation = useNavigation();
  return (
    <View
      className="w-full flex-row items-center justify-between"
      style={{ gap: WORKSPACE_DOCK.gap }}
    >
      <GlassSurface
        style={{
          width: WORKSPACE_DOCK.tabsWidth,
          height: WORKSPACE_DOCK.height,
          borderRadius: WORKSPACE_DOCK.height / 2,
        }}
      >
        <View className="flex-1 flex-row p-1" accessibilityRole="tablist">
          {(["threads", "pullRequests"] as const).map((tab) => {
            const selected = workspace.state.selectedTab === tab;
            return (
              <Pressable
                key={tab}
                accessibilityRole="tab"
                accessibilityLabel={t(tab === "threads" ? "Threads" : "Pull requests")}
                accessibilityState={{ selected }}
                onPress={() => {
                  if (selected) return;
                  Keyboard.dismiss();
                  workspace.dispatch({ type: "select", tab });
                }}
                className={
                  selected
                    ? "flex-1 items-center justify-center rounded-full bg-subtle-strong"
                    : "flex-1 items-center justify-center rounded-full"
                }
              >
                <SymbolView
                  name={tab === "threads" ? "text.bubble" : PullRequestGlyph.pullRequest}
                  size={23}
                  tintColorClassName={selected ? "accent-focus" : "accent-icon"}
                />
              </Pressable>
            );
          })}
        </View>
      </GlassSurface>
      <Menu
        title={t("Task board")}
        shouldOpenOnLongPress
        actions={[
          { id: "tasks", title: t("Task board") },
          { id: "requirements", title: t("Requirements board") },
        ]}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === "requirements") navigation.navigate("Requirements");
          if (nativeEvent.event === "tasks") navigation.navigate("WorkItems");
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Task board")}
          accessibilityHint={t("Long press for more boards")}
          onPress={() => navigation.navigate("WorkItems")}
          className="min-h-12 min-w-12 items-center justify-center"
        >
          <SymbolView name="checkmark.circle" size={23} tintColorClassName="accent-icon" />
        </Pressable>
      </Menu>
      <GlassSurface
        style={{
          width: WORKSPACE_DOCK.height,
          height: WORKSPACE_DOCK.height,
          borderRadius: WORKSPACE_DOCK.height / 2,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("New chat")}
          onPress={props.onNewTask}
          className="flex-1 items-center justify-center"
        >
          <SymbolView name="square.and.pencil" size={23} tintColorClassName="accent-icon" />
        </Pressable>
      </GlassSurface>
    </View>
  );
}

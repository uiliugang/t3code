import { useRoute } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Platform, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { AppBarProps } from "../../../components/ui/AppBar.types";
import { AppBar } from "../../../components/ui/AppBar";
import { ScreenContent as SettingsScreenContent } from "../../../components/ui/ScreenContent";
import { useWorkspaceTabs } from "../../layout/workspace/WorkspaceTabsContext";
import { useDeviceType } from "../../../native/native-layout-metrics";
import { useCompactWorkspaceTabs } from "../../layout/workspace/useSystemWorkspaceTabBar";
import { useSettingsPageBack } from "../useSettingsPageBack";
import {
  ScreenScrollViewBottomInset,
  ScreenScrollViewSurface,
} from "../../../components/ui/ScreenScrollView";

export { SettingsScreenContent };

export function SettingsScreen(
  props: Pick<
    AppBarProps,
    "title" | "actions" | "refresh" | "trailing" | "search" | "menus" | "guardBack"
  > & {
    readonly children: ReactNode;
    readonly workspaceRoot?: boolean;
  },
) {
  const route = useRoute();
  const workspace = useWorkspaceTabs();
  const insets = useSafeAreaInsets();
  const deviceType = useDeviceType();
  const compactTabs = useCompactWorkspaceTabs();
  const back = useSettingsPageBack();
  const cover = deviceType === "duo-folded";
  // Opened as a workspace tab, the Settings list has nothing to go back to.
  const workspaceRoot = props.workspaceRoot || (workspace !== null && route.name === "Settings");

  const surfaceClassName = workspaceRoot || cover ? "bg-screen" : "bg-sheet";
  const iosBottomInset =
    deviceType === "pad" || compactTabs
      ? 80
      : workspace !== null
        ? Math.max(workspace.bottomClearance - insets.bottom, 0)
        : 0;

  return (
    <View collapsable={false} className={`flex-1 ${surfaceClassName}`}>
      <AppBar
        title={props.title}
        actions={props.actions}
        refresh={props.refresh}
        search={props.search}
        trailing={props.trailing}
        menus={props.menus}
        onBack={workspaceRoot ? undefined : back}
        guardBack={props.guardBack}
        hideBottomBorder
      />
      <KeyboardAvoidingView
        automaticOffset
        behavior="padding"
        enabled={Platform.OS === "android"}
        style={{ flex: 1 }}
      >
        <ScreenScrollViewBottomInset value={iosBottomInset}>
          <ScreenScrollViewSurface value={surfaceClassName}>
            <SettingsScreenContent>{props.children}</SettingsScreenContent>
          </ScreenScrollViewSurface>
        </ScreenScrollViewBottomInset>
      </KeyboardAvoidingView>
    </View>
  );
}

import { Platform } from "react-native";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { AndroidNavigationAppearanceSection } from "./appearance/sections/AndroidNavigationAppearanceSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SettingsScreen } from "./components/SettingsScreen";
import { CodeAppearanceSection } from "./appearance/sections/CodeAppearanceSection";
import { TerminalAppearanceSection } from "./appearance/sections/TerminalAppearanceSection";
import { TextAppearanceSection } from "./appearance/sections/TextAppearanceSection";
import { LanguageSection } from "./appearance/sections/LanguageSection";
import { ThemeAppearanceSection } from "./appearance/sections/ThemeAppearanceSection";
import { ProjectPresentationSection } from "./appearance/sections/ProjectPresentationSection";
import { BranchIssuesSection } from "./appearance/sections/BranchIssuesSection";
import { ToolCallsAppearanceSection } from "./appearance/sections/ToolCallsAppearanceSection";

export function SettingsAppearanceRouteScreen() {
  const t = useUiTranslation();
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title={t("Appearance")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <LanguageSection />
        <ThemeAppearanceSection />
        <ProjectPresentationSection />
        <BranchIssuesSection />
        {Platform.OS === "android" ? <AndroidNavigationAppearanceSection /> : null}
        <TextAppearanceSection />
        <TerminalAppearanceSection />
        <CodeAppearanceSection />
        <ToolCallsAppearanceSection />
      </ScrollView>
    </SettingsScreen>
  );
}

import {
  ModelFavorites,
  SidebarProjectGroupingMode,
  PullRequestMergeMethod,
  ToolCallVisibility,
  type ClientSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { MOBILE_THEME_IDS } from "../../lib/mobileTheme";
import { MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE } from "../terminal/terminalPreferences";
import type { Preferences } from "../../persistence/mobile-preferences";
import {
  mobileProjectGroupingModePatch,
  resolveMobileProjectGroupingSettings,
} from "../../state/project-grouping.logic";

const MobileTransferPreferences = Schema.Struct({
  branchIssuesVisible: Schema.optionalKey(Schema.Boolean),
  branchIssuesExpanded: Schema.optionalKey(Schema.Boolean),
  branchIssuesShowEmpty: Schema.optionalKey(Schema.Boolean),
  branchIssuesSeparate: Schema.optionalKey(Schema.Boolean),
  showRepositoryIcons: Schema.optionalKey(Schema.Boolean),
  showGroupIcons: Schema.optionalKey(Schema.Boolean),
  capitalizeProjectNames: Schema.optionalKey(Schema.Boolean),
  uiLanguage: Schema.optionalKey(Schema.Literals(["en", "zh-CN"])),
  navigationTabOrder: Schema.optionalKey(Schema.Array(Schema.String)),
  hiddenNavigationTabs: Schema.optionalKey(Schema.Array(Schema.String)),
  pullRequestHideTestFiles: Schema.optionalKey(Schema.Boolean),
  pullRequestMergeMethod: Schema.optionalKey(PullRequestMergeMethod),
  liveActivitiesEnabled: Schema.optionalKey(Schema.Boolean),
  themeId: Schema.optionalKey(Schema.Literals(MOBILE_THEME_IDS)),
  lightThemeId: Schema.optionalKey(Schema.Literals(MOBILE_THEME_IDS)),
  darkThemeId: Schema.optionalKey(Schema.Literals(MOBILE_THEME_IDS)),
  themeMode: Schema.optionalKey(Schema.Literals(["light", "dark", "system"])),
  androidNavigationStyle: Schema.optionalKey(Schema.Literals(["one-ui", "material"])),
  baseFontSize: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 11, maximum: 22 })),
  ),
  terminalFontSize: Schema.optionalKey(
    Schema.NullOr(
      Schema.Number.check(
        Schema.isBetween({ minimum: MIN_TERMINAL_FONT_SIZE, maximum: MAX_TERMINAL_FONT_SIZE }),
      ),
    ),
  ),
  markdownFontSize: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 8, maximum: 32 })),
  ),
  codeFontSize: Schema.optionalKey(
    Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 8, maximum: 18 }))),
  ),
  codeWordBreak: Schema.optionalKey(Schema.Boolean),
  mathRenderingEnabled: Schema.optionalKey(Schema.Boolean),
  crashReportsEnabled: Schema.optionalKey(Schema.Boolean),
  apkAutoUpdateEnabled: Schema.optionalKey(Schema.Boolean),
  composerEnterBehavior: Schema.optionalKey(Schema.Literals(["send", "newline"])),
  followUpBehavior: Schema.optionalKey(Schema.Literals(["queue", "steer"])),
  showPredictedMessages: Schema.optionalKey(Schema.Boolean),
  projectGroupingEnabled: Schema.optionalKey(Schema.Boolean),
  projectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  toolCallVisibility: Schema.optionalKey(ToolCallVisibility),
  workingShelfEnabled: Schema.optionalKey(Schema.Boolean),
  useLastProjectForNewThreads: Schema.optionalKey(Schema.Boolean),
  modelFavorites: Schema.optionalKey(ModelFavorites),
  threadListSettledShelfExpanded: Schema.optionalKey(Schema.Boolean),
  threadListSnoozedShelfExpanded: Schema.optionalKey(Schema.Boolean),
  threadListWorkingShelfExpanded: Schema.optionalKey(Schema.Boolean),
});
export const decodeMobileTransferPreferences = Schema.decodeUnknownSync(MobileTransferPreferences);
export const exportMobileTransferPreferences = Schema.decodeSync(MobileTransferPreferences);

const COMMON_CLIENT_PREFERENCES = [
  "uiLanguage",
  "showRepositoryIcons",
  "showGroupIcons",
  "capitalizeProjectNames",
  "mathRenderingEnabled",
  "followUpBehavior",
  "showPredictedMessages",
  "toolCallVisibility",
  "branchIssuesExpanded",
  "branchIssuesShowEmpty",
] as const;

export function mobileClientSettingsForExport(preferences: Preferences): Partial<ClientSettings> {
  return {
    ...Struct.pick(preferences, COMMON_CLIENT_PREFERENCES),
    favorites: preferences.modelFavorites ?? [],
    ...(preferences.branchIssuesSeparate === undefined
      ? {}
      : { branchIssuesPlacement: preferences.branchIssuesSeparate ? "separate" : "inline" }),
    ...(preferences.workingShelfEnabled === undefined
      ? {}
      : { sidebarWorkingShelfEnabled: preferences.workingShelfEnabled }),
    ...(preferences.projectGroupingMode === undefined &&
    preferences.projectGroupingEnabled === undefined
      ? {}
      : {
          sidebarProjectGroupingMode:
            resolveMobileProjectGroupingSettings(preferences).sidebarProjectGroupingMode,
        }),
  };
}

export function mobilePreferencesFromClientSettings(
  settings: Partial<ClientSettings>,
): Partial<Preferences> {
  return {
    ...Struct.pick(settings, COMMON_CLIENT_PREFERENCES),
    ...(settings.favorites === undefined ? {} : { modelFavorites: settings.favorites }),
    ...(settings.branchIssuesPlacement === undefined
      ? {}
      : { branchIssuesSeparate: settings.branchIssuesPlacement === "separate" }),
    ...(settings.threadDetailsItems === undefined
      ? {}
      : { branchIssuesVisible: settings.threadDetailsItems.issues ?? true }),
    ...(settings.sidebarWorkingShelfEnabled === undefined
      ? {}
      : { workingShelfEnabled: settings.sidebarWorkingShelfEnabled }),
    ...(settings.sidebarProjectGroupingMode === undefined
      ? {}
      : mobileProjectGroupingModePatch(settings.sidebarProjectGroupingMode)),
  };
}

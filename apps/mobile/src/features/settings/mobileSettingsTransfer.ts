import {
  assertSettingsFileSize,
  parseSettingsFile,
  serializeSettingsFile,
  type SettingsFile,
} from "@t3tools/client-runtime/settings-transfer";
import {
  ModelFavorites,
  SidebarProjectGroupingMode,
  PullRequestMergeMethod,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Directory, File, Paths } from "expo-file-system";

import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import { MOBILE_THEME_IDS } from "../../lib/mobileTheme";
import { uuidv4 } from "../../lib/uuid";
import { MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE } from "../terminal/terminalPreferences";

const MobileTransferPreferences = Schema.Struct({
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
  composerEnterBehavior: Schema.optionalKey(Schema.Literals(["send", "newline"])),
  followUpBehavior: Schema.optionalKey(Schema.Literals(["queue", "steer"])),
  showPredictedMessages: Schema.optionalKey(Schema.Boolean),
  projectGroupingEnabled: Schema.optionalKey(Schema.Boolean),
  projectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  planModeEnabled: Schema.optionalKey(Schema.Boolean),
  workingShelfEnabled: Schema.optionalKey(Schema.Boolean),
  useLastProjectForNewThreads: Schema.optionalKey(Schema.Boolean),
  modelFavorites: Schema.optionalKey(ModelFavorites),
  threadListSettledShelfExpanded: Schema.optionalKey(Schema.Boolean),
  threadListSnoozedShelfExpanded: Schema.optionalKey(Schema.Boolean),
  threadListWorkingShelfExpanded: Schema.optionalKey(Schema.Boolean),
});
export const decodeMobileTransferPreferences = Schema.decodeUnknownSync(MobileTransferPreferences);
export const exportMobileTransferPreferences = Schema.decodeSync(MobileTransferPreferences);

export async function pickSettingsFile(): Promise<SettingsFile | null> {
  const { getDocumentAsync } = await import("expo-document-picker");
  const finishHandoff = beginForegroundHandoff();
  try {
    const result = await getDocumentAsync({
      type: ["application/json", "text/plain"],
      copyToCacheDirectory: true,
    });
    if (result.canceled) return null;
    const asset = result.assets[0];
    if (!asset) return null;
    const file = new File(asset.uri);
    try {
      assertSettingsFileSize(asset.size ?? file.size);
      return parseSettingsFile(await file.text());
    } finally {
      file.delete();
    }
  } finally {
    finishHandoff();
  }
}

export async function shareSettingsFile(settings: SettingsFile): Promise<void> {
  const sharing = await import("expo-sharing");
  if (!(await sharing.isAvailableAsync()))
    throw new Error("File sharing is unavailable on this device.");
  const contents = serializeSettingsFile(settings);
  const directory = new Directory(Paths.cache, `settings-export-${uuidv4()}`);
  directory.create();
  const file = new File(directory, `t3-code-${settings.scope}-settings.json`);
  const finishHandoff = beginForegroundHandoff();
  try {
    file.write(contents);
    await sharing.shareAsync(file.uri, { mimeType: "application/json", UTI: "public.json" });
  } finally {
    finishHandoff();
    directory.delete();
  }
}

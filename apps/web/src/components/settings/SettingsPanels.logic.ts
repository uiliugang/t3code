import type {
  BackgroundActivityProfile,
  BackgroundActivitySettings,
  ProviderInstanceConfig,
  PreviewViewportSetting,
  ProviderInstanceId,
  ServerSettings,
  SidebarProjectGroupingMode,
  UnifiedSettings,
} from "@t3tools/contracts";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@t3tools/contracts/settings";
import {
  getBackgroundActivityBaseProfile,
  normalizeBackgroundActivitySettings,
  normalizeServerBackgroundActivitySettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import { translateUi, type UiTranslator } from "@t3tools/shared/uiLocale";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export function isProjectGroupingEnabled(mode: SidebarProjectGroupingMode): boolean {
  return mode !== "separate";
}

export function projectGroupingModeFromToggle(
  enabled: boolean,
  lastEnabledMode: SidebarProjectGroupingMode = "repository",
): SidebarProjectGroupingMode {
  if (!enabled) return "separate";
  return lastEnabledMode === "repository_path" ? "repository_path" : "repository";
}

const LAST_ENABLED_PROJECT_GROUPING_MODE_KEY = "t3code:last-enabled-project-grouping-mode";

export function readLastEnabledProjectGroupingMode(): SidebarProjectGroupingMode {
  try {
    return localStorage.getItem(LAST_ENABLED_PROJECT_GROUPING_MODE_KEY) === "repository_path"
      ? "repository_path"
      : "repository";
  } catch {
    return "repository";
  }
}

export function rememberEnabledProjectGroupingMode(mode: SidebarProjectGroupingMode): void {
  if (mode === "separate") return;
  try {
    localStorage.setItem(LAST_ENABLED_PROJECT_GROUPING_MODE_KEY, mode);
  } catch {}
}

export function hasChangedBackgroundActivitySettings(
  settings: Pick<
    UnifiedSettings,
    | "backgroundActivity"
    | "backgroundActivityProfile"
    | "automaticGitFetchInterval"
    | "providerHealthRefreshInterval"
  >,
): boolean {
  return (
    !Equal.equals(settings.backgroundActivity, DEFAULT_UNIFIED_SETTINGS.backgroundActivity) ||
    settings.backgroundActivityProfile !== DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile ||
    !Equal.equals(
      settings.automaticGitFetchInterval,
      DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
    ) ||
    !Equal.equals(
      settings.providerHealthRefreshInterval,
      DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
    )
  );
}

type TypographySettings = Pick<
  UnifiedSettings,
  | "fontFamilySans"
  | "fontFamilyComposer"
  | "fontFamilyCode"
  | "fontFamilyTerminal"
  | "fontSizeInterface"
  | "fontSizePrompt"
  | "fontSizeCode"
  | "fontSizeTerminal"
>;

function getChangedTypographySettingLabels(
  settings: TypographySettings,
  resolve: MessageResolver = m,
): string[] {
  return [
    ...(settings.fontFamilySans !== DEFAULT_UNIFIED_SETTINGS.fontFamilySans ||
    settings.fontSizeInterface !== DEFAULT_UNIFIED_SETTINGS.fontSizeInterface
      ? [resolve(msg("Interface font"))]
      : []),
    ...(settings.fontFamilyComposer !== DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer ||
    settings.fontSizePrompt !== DEFAULT_UNIFIED_SETTINGS.fontSizePrompt
      ? [resolve(msg("Prompt font"))]
      : []),
    ...(settings.fontFamilyCode !== DEFAULT_UNIFIED_SETTINGS.fontFamilyCode ||
    settings.fontSizeCode !== DEFAULT_UNIFIED_SETTINGS.fontSizeCode
      ? [resolve(msg("Code font"))]
      : []),
    ...(settings.fontFamilyTerminal !== DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal ||
    settings.fontSizeTerminal !== DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal
      ? [resolve(msg("Terminal font"))]
      : []),
  ];
}

export type BrowserDefaultSettings = Pick<
  UnifiedSettings,
  | "browserDefaultViewport"
  | "browserDefaultZoomFactor"
  | "browserDefaultAppearance"
  | "browserRecordingFrameRate"
  | "browserRecordingShowKeyPresses"
  | "browserRecordingShowMousePresses"
  | "browserLinkTarget"
  | "browserSearchEngine"
  | "browserCustomSearchUrl"
  | "browserAutoShowFloatingPreview"
  | "pullRequestLinksOpenInApp"
>;

function isSamePreviewViewport(
  left: PreviewViewportSetting,
  right: PreviewViewportSetting,
): boolean {
  if (left._tag !== right._tag) return false;
  if (left._tag === "fill" || right._tag === "fill") return true;
  if (left.width !== right.width || left.height !== right.height) return false;
  return left._tag === "preset" && right._tag === "preset"
    ? left.presetId === right.presetId
    : true;
}

export function getChangedBrowserSettingLabels(
  settings: BrowserDefaultSettings,
  resolve: MessageResolver = m,
): string[] {
  return [
    ...(isSamePreviewViewport(
      settings.browserDefaultViewport,
      DEFAULT_UNIFIED_SETTINGS.browserDefaultViewport,
    )
      ? []
      : [resolve(msg("Browser viewport"))]),
    ...(settings.browserDefaultZoomFactor !== DEFAULT_UNIFIED_SETTINGS.browserDefaultZoomFactor
      ? [resolve(msg("Browser zoom"))]
      : []),
    ...(settings.browserDefaultAppearance !== DEFAULT_UNIFIED_SETTINGS.browserDefaultAppearance
      ? [resolve(msg("Browser appearance"))]
      : []),
    ...(settings.browserRecordingFrameRate !== DEFAULT_UNIFIED_SETTINGS.browserRecordingFrameRate
      ? [resolve(msg("Recording frame rate"))]
      : []),
    ...(settings.browserRecordingShowKeyPresses ? [resolve(msg("Recording key presses"))] : []),
    ...(settings.browserRecordingShowMousePresses ? [resolve(msg("Recording mouse presses"))] : []),
    ...(settings.browserLinkTarget !== DEFAULT_UNIFIED_SETTINGS.browserLinkTarget
      ? [resolve(msg("Open links in"))]
      : []),
    ...(settings.browserSearchEngine !== DEFAULT_UNIFIED_SETTINGS.browserSearchEngine ||
    settings.browserCustomSearchUrl !== DEFAULT_UNIFIED_SETTINGS.browserCustomSearchUrl
      ? [resolve(msg("Search engine"))]
      : []),
    ...(settings.browserAutoShowFloatingPreview !==
    DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview
      ? [resolve(msg("Floating preview"))]
      : []),
    ...(settings.pullRequestLinksOpenInApp !== DEFAULT_UNIFIED_SETTINGS.pullRequestLinksOpenInApp
      ? [resolve(msg("Open pull requests in T3 Code"))]
      : []),
  ];
}

export function getChangedUnifiedSettingLabels(
  input: {
    readonly settings: UnifiedSettings;
    readonly theme: string;
    readonly followSystem: boolean;
    readonly hasThemeHalves: boolean;
  },
  resolve: MessageResolver = m,
  t: UiTranslator = translateUi.bind(null, "en"),
): string[] {
  const { settings, theme, followSystem, hasThemeHalves } = input;
  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const isBackgroundActivityDirty = hasChangedBackgroundActivitySettings(settings);

  return [
    ...(theme !== "system" ? [resolve(msg("Theme"))] : []),
    ...(!followSystem ? [resolve(msg("Follow system"))] : []),
    ...(hasThemeHalves ? [resolve(msg("Theme mix"))] : []),
    ...(settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast
      ? [resolve(msg("Contrast"))]
      : []),
    ...(settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity
      ? [resolve(msg("Glass opacity"))]
      : []),
    ...(settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme ||
    !Equal.equals(settings.diffCustomColors, DEFAULT_UNIFIED_SETTINGS.diffCustomColors)
      ? [resolve(msg("Diff colors"))]
      : []),
    ...(settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth
      ? [resolve(msg("Chat width"))]
      : []),
    ...(settings.effortDisplay !== DEFAULT_UNIFIED_SETTINGS.effortDisplay
      ? [resolve(msg("Effort display"))]
      : []),
    ...(settings.mathRenderingEnabled !== DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled
      ? [resolve(msg("Render math"))]
      : []),
    ...(settings.panelAnimationDurationMs !== DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs
      ? [resolve(msg("Panel animations"))]
      : []),
    ...(settings.environmentIdentificationMode !==
    DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode
      ? [resolve(msg("Environment identification"))]
      : []),
    ...(settings.uiLanguage !== DEFAULT_UNIFIED_SETTINGS.uiLanguage
      ? [resolve(msg("Language"))]
      : []),
    ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
      ? [resolve(msg("Time format"))]
      : []),
    ...(settings.notificationMode !== DEFAULT_UNIFIED_SETTINGS.notificationMode
      ? [resolve(msg("Thread notifications"))]
      : []),
    ...(settings.inAppNotificationsEnabled !== DEFAULT_UNIFIED_SETTINGS.inAppNotificationsEnabled
      ? [resolve(msg("In-app notifications"))]
      : []),
    ...(settings.sidebarProjectGroupingMode !== DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode
      ? [resolve(msg("Project Grouping"))]
      : []),
    ...(settings.sidebarProjectSortOrder !== DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder
      ? [resolve(msg("Project order"))]
      : []),
    ...(settings.sidebarWorkingShelfEnabled !== DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled
      ? [resolve(msg("Working section"))]
      : []),
    ...(settings.sidebarAutoSettleAfterDays !== DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays
      ? [resolve(msg("Auto-settle inactive threads"))]
      : []),
    ...(settings.sidebarAutoSettleKeepPullRequests !==
    DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleKeepPullRequests
      ? [resolve(msg("Keep threads with a PR"))]
      : []),
    ...(settings.sidebarAutoSettleOnMerge !== DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge
      ? [resolve(msg("Auto-settle merged threads"))]
      : []),
    ...(settings.autoResumeLimitedThreads !== DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads
      ? [resolve(msg("Resume after usage limits"))]
      : []),
    ...(settings.snoozeLimitedThreads !== DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads
      ? [resolve(msg("Snooze until limits reset"))]
      : []),
    ...(!Equal.equals(settings.snoozePresets, DEFAULT_UNIFIED_SETTINGS.snoozePresets)
      ? [resolve(msg("Snooze options"))]
      : []),
    ...(settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? [resolve(msg("Word wrap"))] : []),
    ...(settings.persistComposerContextStrip !==
    DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip
      ? [resolve(msg("Composer context"))]
      : []),
    ...getChangedTypographySettingLabels(settings, resolve),
    ...(settings.diffFilesCollapsed !== DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed
      ? [resolve(msg("Default diff file state"))]
      : []),
    ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
      ? [resolve(msg("Diff whitespace changes"))]
      : []),
    ...(settings.diffLayout !== DEFAULT_UNIFIED_SETTINGS.diffLayout
      ? [resolve(msg("Diff layout"))]
      : []),
    ...(settings.proactivePanelsEnabled !== DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled
      ? [resolve(msg("Open pull requests and changes panels proactively"))]
      : []),
    ...(settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu
      ? [resolve(msg("Show skills in slash menu"))]
      : []),
    ...(settings.composerRichTextEnabled !== DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled
      ? [resolve(msg("Rich text composer"))]
      : []),
    ...(settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut
      ? [resolve(msg("Send shortcut"))]
      : []),
    ...(settings.sideThreadOpenTarget !== DEFAULT_UNIFIED_SETTINGS.sideThreadOpenTarget
      ? [resolve(msg("Subagents and side chats"))]
      : []),
    ...(settings.showPredictedMessages !== DEFAULT_UNIFIED_SETTINGS.showPredictedMessages
      ? [resolve(msg("Show predicted messages"))]
      : []),
    ...(settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior
      ? [resolve(msg("Follow-up behavior"))]
      : []),
    ...(settings.toolCallVisibility !== DEFAULT_UNIFIED_SETTINGS.toolCallVisibility
      ? [resolve(msg("Tool calls in chat"))]
      : []),
    ...(settings.screenReaderAnnouncements !== DEFAULT_UNIFIED_SETTINGS.screenReaderAnnouncements
      ? [resolve(msg("Screen reader announcements"))]
      : []),
    ...(settings.contextWindowMeterEnabled !== DEFAULT_UNIFIED_SETTINGS.contextWindowMeterEnabled
      ? [t("Context window indicator")]
      : []),
    ...(settings.screenReaderWindowTitle !== DEFAULT_UNIFIED_SETTINGS.screenReaderWindowTitle
      ? [resolve(msg("Screen reader window title"))]
      : []),
    ...(settings.responseStreamingMode !== DEFAULT_UNIFIED_SETTINGS.responseStreamingMode
      ? [resolve(msg("Response streaming"))]
      : []),
    ...(settings.enableProviderUpdateChecks !== DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks
      ? [resolve(msg("Provider update checks"))]
      : []),
    ...(settings.continueThreadsAfterServerUpdate !==
    DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate
      ? [resolve(msg("Continue threads after restarts"))]
      : []),
    ...(isBackgroundActivityDirty ? [resolve(msg("Background activity"))] : []),
    ...(settings.keepAwakeWhileAgentsWork !== DEFAULT_UNIFIED_SETTINGS.keepAwakeWhileAgentsWork
      ? [resolve(msg("Keep awake while agents work"))]
      : []),
    ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
      ? [resolve(msg("New thread mode"))]
      : []),
    ...(settings.newWorktreesStartFromOrigin !==
    DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin
      ? [resolve(msg("New worktrees start from remote"))]
      : []),
    ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
      ? [resolve(msg("Add project base directory"))]
      : []),
    ...(settings.newWorktreesMainBranchOnly !== DEFAULT_UNIFIED_SETTINGS.newWorktreesMainBranchOnly
      ? [t("New thread worktrees: main/master only")]
      : []),
    ...(settings.childWorktreesMainBranchOnly !==
    DEFAULT_UNIFIED_SETTINGS.childWorktreesMainBranchOnly
      ? [t("Subagent and side chat worktrees: main/master only")]
      : []),
    ...(settings.remoteBranchDisplayDays !== DEFAULT_UNIFIED_SETTINGS.remoteBranchDisplayDays
      ? [t("Remote branch display days")]
      : []),
    ...(settings.hideMergedRemoteBranches !== DEFAULT_UNIFIED_SETTINGS.hideMergedRemoteBranches
      ? [t("Hide merged remote branches")]
      : []),
    ...(settings.autoDeleteMergedBranches !== DEFAULT_UNIFIED_SETTINGS.autoDeleteMergedBranches
      ? [t("Automatically delete merged branches and worktrees")]
      : []),
    ...(settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin
      ? [resolve(msg("Unpin confirmation"))]
      : []),
    ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
      ? [resolve(msg("Archive confirmation"))]
      : []),
    ...(settings.confirmTerminalClose !== DEFAULT_UNIFIED_SETTINGS.confirmTerminalClose
      ? [resolve(msg("Terminal close confirmation"))]
      : []),
    ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
      ? [resolve(msg("Delete confirmation"))]
      : []),
    ...(settings.confirmQuit !== DEFAULT_UNIFIED_SETTINGS.confirmQuit
      ? [resolve(msg("Quit shortcut"))]
      : []),
    ...(isTextGenerationModelDirty ? [resolve(msg("Text generation model"))] : []),
    ...(settings.threadTitleInstructions !== DEFAULT_UNIFIED_SETTINGS.threadTitleInstructions
      ? [resolve(msg("Thread title instructions"))]
      : []),
    ...getChangedBrowserSettingLabels(settings, resolve),
    ...(settings.enableAgentBrowserAccess !== DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess
      ? [resolve(msg("Agent browser access"))]
      : []),
  ];
}

export function resolveBackgroundActivityProfileOption(
  settings: ServerSettings,
): BackgroundActivityProfile | "advanced" {
  const resolved = resolveServerBackgroundActivitySettings(settings);
  const normalized = normalizeBackgroundActivitySettings({
    schemaVersion: 1,
    profile: "custom",
    baseProfile: resolved.profile,
    overrides: {
      automaticGitFetchInterval: resolved.automaticGitFetchInterval,
      providerHealthRefreshInterval: resolved.providerHealthRefreshInterval,
      hostPowerMonitorActiveInterval: resolved.hostPowerMonitorActiveInterval,
      hostPowerMonitorIdleInterval: resolved.hostPowerMonitorIdleInterval,
      pauseWhenHostLocked: resolved.pauseWhenHostLocked,
      pauseWhenHostLowPower: resolved.pauseWhenHostLowPower,
      pauseWhenClientLowPower: resolved.pauseWhenClientLowPower,
      pauseWhenOnBattery: resolved.pauseWhenOnBattery,
    },
  });
  return normalized.profile === "custom" ? "advanced" : normalized.profile;
}

export function backgroundActivitySharedPolicySettings(
  settings: ServerSettings,
  profile: BackgroundActivityProfile,
): BackgroundActivitySettings {
  const normalized = normalizeServerBackgroundActivitySettings(settings);
  return {
    schemaVersion: 1,
    profile: "custom",
    baseProfile: profile,
    overrides: normalized.profile === "custom" ? normalized.overrides : {},
  };
}

export function buildProviderInstanceUpdatePatch(input: {
  readonly settings: Pick<ServerSettings, "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly textGenerationModelSelection?:
    | ServerSettings["textGenerationModelSelection"]
    | undefined;
}) {
  return {
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: input.instance,
    },
    ...(input.textGenerationModelSelection !== undefined
      ? { textGenerationModelSelection: input.textGenerationModelSelection }
      : {}),
  };
}

export const PROVIDER_HEALTH_INTERVAL_STEP_SECONDS = 30;

type BackgroundActivityOverridePatch = Partial<{
  [K in keyof BackgroundActivitySettings["overrides"]]:
    | BackgroundActivitySettings["overrides"][K]
    | undefined;
}>;

export function durationToSeconds(duration: Duration.Duration): number {
  return Math.round(Duration.toMillis(duration) / 1_000);
}

export function normalizeIntervalSeconds(value: number | null, minimum = 0): number {
  if (value === null || !Number.isFinite(value)) {
    return minimum;
  }
  return Math.max(minimum, Math.round(value));
}

export function backgroundActivityOverrideSettings(
  current: BackgroundActivitySettings,
  resolved: ReturnType<typeof resolveServerBackgroundActivitySettings>,
  overrides: BackgroundActivityOverridePatch,
) {
  const nextOverrides: BackgroundActivityOverridePatch = {
    automaticGitFetchInterval: resolved.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolved.providerHealthRefreshInterval,
    hostPowerMonitorActiveInterval: resolved.hostPowerMonitorActiveInterval,
    hostPowerMonitorIdleInterval: resolved.hostPowerMonitorIdleInterval,
    pauseWhenHostLocked: resolved.pauseWhenHostLocked,
    pauseWhenHostLowPower: resolved.pauseWhenHostLowPower,
    pauseWhenClientLowPower: resolved.pauseWhenClientLowPower,
    pauseWhenOnBattery: resolved.pauseWhenOnBattery,
    ...overrides,
  };
  for (const [key, value] of Object.entries(nextOverrides)) {
    if (value === undefined) {
      delete nextOverrides[key as keyof typeof nextOverrides];
    }
  }
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile: "custom" as const,
      baseProfile: getBackgroundActivityBaseProfile(current),
      overrides: nextOverrides as BackgroundActivitySettings["overrides"],
    },
  };
}

/**
 * Saving a shorter age settles threads at once, so typing stays in `draft` until the edit is
 * finished. `pending` is the submission in flight; `saved` is the only value a draft falls back to.
 */
export interface AutoSettleDaysField {
  readonly saved: number;
  readonly draft: string;
  readonly dirty: boolean;
  readonly pending: number | null;
  readonly revision: number;
}

export function autoSettleDaysField(saved: number): AutoSettleDaysField {
  return { saved, draft: String(saved), dirty: false, pending: null, revision: 0 };
}

export function syncAutoSettleDaysField(
  field: AutoSettleDaysField,
  saved: number,
): AutoSettleDaysField {
  // An earlier save can be confirmed while a later one is still in flight.
  const pending = field.pending === saved ? null : field.pending;
  if (field.saved === saved && pending === field.pending) return field;
  return {
    ...field,
    saved,
    pending,
    draft: field.dirty ? field.draft : String(pending ?? saved),
  };
}

export function editAutoSettleDaysField(
  field: AutoSettleDaysField,
  draft: string,
): AutoSettleDaysField {
  return { ...field, draft, dirty: true };
}

export function cancelAutoSettleDaysField(field: AutoSettleDaysField): AutoSettleDaysField {
  return { ...field, draft: String(field.pending ?? field.saved), dirty: false };
}

export function commitAutoSettleDaysField(field: AutoSettleDaysField): {
  readonly field: AutoSettleDaysField;
  readonly submit: number | null;
} {
  const current = field.pending ?? field.saved;
  const days = field.draft.trim() === "" ? Number.NaN : Number(field.draft);
  if (
    !Number.isInteger(days) ||
    days < MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS ||
    days > MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
  ) {
    return { field: { ...field, draft: String(current), dirty: false }, submit: null };
  }
  const settled = { ...field, draft: String(days), dirty: false };
  // An edit ending on the saved value is sent again: a save can land on the shown environment
  // and fail on another, and retyping the number is how it is retried.
  if (!field.dirty || days === field.pending) return { field: settled, submit: null };
  return { field: { ...settled, pending: days, revision: field.revision + 1 }, submit: days };
}

export function failAutoSettleDaysField(
  field: AutoSettleDaysField,
  revision: number,
): AutoSettleDaysField {
  if (field.revision !== revision) return field;
  return { ...field, pending: null, draft: field.dirty ? field.draft : String(field.saved) };
}

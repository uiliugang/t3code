import { foldSearchQuery, rankSearchItems, scoreSearchTerms } from "@t3tools/shared/paletteSearch";
import type { UiTranslator } from "@t3tools/shared/uiLocale";
import { mFallback, msg } from "gt-react-native";
import { m, type MessageResolver } from "../../i18n/messages";

import type { SettingsPageTarget } from "./components/settings-page-targets";

/** What each page holds besides its row's label, so search finds a setting by its own name. */
const SETTINGS_SEARCH_TERMS = {
  account: [
    msg("sign in", { $context: "settings search keyword" }),
    msg("sign out", { $context: "settings search keyword" }),
    msg("login", { $context: "settings search keyword" }),
    "clerk",
    msg("connect", { $context: "settings search keyword" }),
  ],
  SettingsEnvironments: [
    msg("servers", { $context: "settings search keyword" }),
    msg("connections", { $context: "settings search keyword" }),
    msg("pair", { $context: "settings search keyword" }),
    msg("add environment", { $context: "settings search keyword" }),
    msg("remote", { $context: "settings search keyword" }),
    "tailscale",
  ],
  SettingsNotifications: ["push", "alerts", "live activity", "agent activity"],
  SettingsMeituan: ["meituan", "美团", "MIS", "MEP", "ONES", "MCM", "daxiang", "大象", "mtskills"],
  SettingsSharingAccess: ["sharing", "access", "wechat", "微信", "配对", "推送"],
  SettingsAppearance: [
    msg("theme", { $context: "settings search keyword" }),
    msg("dark mode", { $context: "settings search keyword" }),
    msg("light mode", { $context: "settings search keyword" }),
    msg("colors", { $context: "settings search keyword" }),
    msg("font size", { $context: "settings search keyword" }),
    msg("text size", { $context: "settings search keyword" }),
    msg("code", { $context: "settings search keyword" }),
    msg("diffs", { $context: "settings search keyword" }),
    msg("terminal", { $context: "settings search keyword" }),
    msg("word break", { $context: "settings search keyword" }),
    msg("math", { $context: "settings search keyword" }),
    msg("tool calls in chat", { $context: "settings search keyword" }),
    msg("hide tool calls", { $context: "settings search keyword" }),
    msg("commands edits searches", { $context: "settings search keyword" }),
    msg("work log", { $context: "settings search keyword" }),
    msg("zen", { $context: "settings search keyword" }),
    msg("final answers only", { $context: "settings search keyword" }),
  ],
  SettingsNavigation: [
    msg("tabs", { $context: "settings search keyword" }),
    msg("tab order", { $context: "settings search keyword" }),
    msg("reorder", { $context: "settings search keyword" }),
    msg("hide tabs", { $context: "settings search keyword" }),
  ],
  SettingsKeyboard: [
    msg("return key", { $context: "settings search keyword" }),
    msg("send message", { $context: "settings search keyword" }),
    msg("new line", { $context: "settings search keyword" }),
    msg("hardware keyboard", { $context: "settings search keyword" }),
  ],
  SettingsVoice: [
    msg("microphone", { $context: "settings search keyword" }),
    msg("dictation", { $context: "settings search keyword" }),
    msg("transcription", { $context: "settings search keyword" }),
    msg("transcribe on", { $context: "settings search keyword" }),
    msg("transcription model", { $context: "settings search keyword" }),
    msg("this device", { $context: "settings search keyword" }),
    msg("environment", { $context: "settings search keyword" }),
    msg("on-device", { $context: "settings search keyword" }),
    msg("audio input", { $context: "settings search keyword" }),
    msg("preferred microphone", { $context: "settings search keyword" }),
    msg("microphone order", { $context: "settings search keyword" }),
    msg("bluetooth", { $context: "settings search keyword" }),
  ],
  SettingsScheduledTasks: [
    msg("automations", { $context: "settings search keyword" }),
    msg("schedule", { $context: "settings search keyword" }),
    "cron",
    msg("recurring", { $context: "settings search keyword" }),
    msg("webhook", { $context: "settings search keyword" }),
  ],
  SettingsProjectOverview: [
    msg("project", { $context: "settings search keyword" }),
    msg("overview", { $context: "settings search keyword" }),
    msg("checkouts", { $context: "settings search keyword" }),
    msg("delete project", { $context: "settings search keyword" }),
    "git",
    "identity",
    "configuration",
    "import",
    "export",
    "backup",
  ],
  SettingsOrganization: [
    "language",
    "locale",
    "translation",
    "english",
    "语言",
    "中文",
    "简体中文",
    "英语",
    "project grouping",
    "group projects",
    "organization",
    "sidebar",
    "working section",
    "new threads",
    "last project",
  ],
  SettingsThreads: [
    msg("new threads", { $context: "settings search keyword" }),
    msg("default workspace", { $context: "settings search keyword" }),
    msg("default permissions", { $context: "settings search keyword" }),
    msg("access", { $context: "settings search keyword" }),
    msg("response streaming", { $context: "settings search keyword" }),
    msg("preview browser", { $context: "settings search keyword" }),
    msg("browser access", { $context: "settings search keyword" }),
    msg("auto-settle", { $context: "settings search keyword" }),
    msg("settle", { $context: "settings search keyword" }),
    msg("snooze", { $context: "settings search keyword" }),
    msg("usage limits", { $context: "settings search keyword" }),
    msg("auto-resume", { $context: "settings search keyword" }),
    msg("thread behavior", { $context: "settings search keyword" }),
  ],
  SettingsFollowUp: [
    msg("follow-ups", { $context: "settings search keyword" }),
    msg("queue", { $context: "settings search keyword" }),
    msg("steer", { $context: "settings search keyword" }),
    msg("while the agent is running", { $context: "settings search keyword" }),
  ],
  SettingsArchive: [
    msg("archive", { $context: "settings search keyword" }),
    msg("archived", { $context: "settings search keyword" }),
    msg("restore", { $context: "settings search keyword" }),
    msg("unarchive", { $context: "settings search keyword" }),
  ],
  SettingsSkills: ["skills", "install", "sources", "update", "rollback", "mtskills"],
  SettingsProviderAccounts: [
    msg("provider accounts", { $context: "settings search keyword" }),
    "codex",
    "claude",
    "cursor",
    "opencode",
    msg("sign in", { $context: "settings search keyword" }),
    msg("login", { $context: "settings search keyword" }),
    msg("auth", { $context: "settings search keyword" }),
  ],
  SettingsEnvironmentSourceControl: [
    "main",
    "master",
    "merged branches",
    "automatic cleanup",
    "worktree base",
    "合并",
    "清理",
    "基线",
    "git",
    msg("pull requests", { $context: "settings search keyword" }),
    msg("co-authors", { $context: "settings search keyword" }),
    msg("agent credits", { $context: "settings search keyword" }),
    msg("default branch", { $context: "settings search keyword" }),
    msg("automatically pull", { $context: "settings search keyword" }),
    msg("clone into host folders", { $context: "settings search keyword" }),
    "ghq",
  ],
  SettingsWorktrees: [
    "remote branch display days",
    "hide merged remote branches",
    "隐藏已合并的远程分支",
    "14 days",
    "远程分支展示天数",
    "worktree",
    "branch naming",
    "branch prefix",
    "submodules",
    "start from remote",
  ],
  SettingsLabs: [
    msg("beta", { $context: "settings search keyword" }),
    msg("linked environments", { $context: "settings search keyword" }),
    msg("link machine", { $context: "settings search keyword" }),
    msg("fast worktree checkout", { $context: "settings search keyword" }),
    msg("clone cache", { $context: "settings search keyword" }),
  ],
  SettingsEnvironmentMaintenance: [
    msg("updates", { $context: "settings search keyword" }),
    msg("provider updates", { $context: "settings search keyword" }),
    msg("restart", { $context: "settings search keyword" }),
    msg("manage environments", { $context: "settings search keyword" }),
  ],
  SettingsClientStorage: ["configuration", "import", "export", "backup", "restore", "sync", "JSON"],
  SettingsAbout: [
    "version",
    "apk updates automatic download install",
    "应用更新 自动下载 安装",
    "diagnostics",
    "client storage",
    "import export configuration backup sync",
    "cache",
    "legal",
    "privacy",
    "terms",
    "open source licenses",
  ],
} satisfies Partial<Record<SettingsPageTarget | "account", readonly string[]>>;
const termsById: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(SETTINGS_SEARCH_TERMS),
);

export interface SettingsSearchRow {
  readonly id: string;
  readonly label: string;
}

export interface SettingsSearchSection<Row extends SettingsSearchRow> {
  readonly title?: string;
  readonly rows: readonly Row[];
}

/**
 * Keeps the rows whose label, section, or page contents match `query`, in list order, and drops
 * sections left empty. Matching is the command palette's, so both searches agree.
 */
export function filterSettingsSections<
  Row extends SettingsSearchRow,
  Section extends SettingsSearchSection<Row>,
>(
  sections: readonly Section[],
  query: string,
  translate: UiTranslator = (message) => message,
  resolve: MessageResolver = m,
): Section[] {
  const normalizedQuery = foldSearchQuery(query);
  const rows = sections.flatMap((section) =>
    section.rows.map((row) => ({ row, section: section.title })),
  );
  const matched = normalizedQuery
    ? new Set(
        rankSearchItems(rows, ({ row, section }, options) =>
          scoreSearchTerms(
            normalizedQuery,
            [
              row.label,
              translate(row.label),
              ...(section ? [section, translate(section)] : []),
              ...(termsById.get(row.id) ?? []).flatMap((term) => [mFallback(term), resolve(term)]),
            ],
            options,
          ),
        ).map(({ item }) => item.row),
      )
    : null;
  return sections.flatMap((section) => {
    const kept = matched ? section.rows.filter((row) => matched.has(row)) : section.rows;
    return kept.length ? [{ ...section, rows: kept }] : [];
  });
}

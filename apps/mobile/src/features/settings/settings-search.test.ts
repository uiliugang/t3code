import { describe, expect, it } from "vite-plus/test";
import { translateUi } from "@t3tools/shared/uiLocale";
import { decodeOptions, mFallback } from "gt-react-native";

import type { MessageResolver } from "../../i18n/messages";
import { filterSettingsSections } from "./settings-search";

const SECTIONS = [
  { rows: [{ id: "usage", label: "Usage" }] },
  {
    title: "Connections",
    rows: [
      { id: "account", label: "T3 Account" },
      { id: "SettingsEnvironments", label: "Environments" },
    ],
  },
  {
    title: "Interface",
    rows: [
      { id: "SettingsAppearance", label: "Appearance" },
      { id: "SettingsKeyboard", label: "Keyboard" },
      { id: "SettingsVoice", label: "Voice" },
    ],
  },
  {
    title: "Server settings",
    rows: [
      { id: "SettingsProviderAccounts", label: "Provider accounts" },
      { id: "SettingsEnvironmentSourceControl", label: "Source control & issues" },
    ],
  },
];

function visible(query: string) {
  return filterSettingsSections(SECTIONS, query).map((section) => [
    section.title ?? null,
    section.rows.map((row) => row.label),
  ]);
}

describe("filterSettingsSections", () => {
  it.each([
    {
      query: "",
      expected: SECTIONS.map((section) => [
        section.title ?? null,
        section.rows.map((row) => row.label),
      ]),
    },
    { query: "   ", expected: visible("") },
    { query: "appear", expected: [["Interface", ["Appearance"]]] },
    { query: "KEYBOARD", expected: [["Interface", ["Keyboard"]]] },
    { query: "dark mode", expected: [["Interface", ["Appearance"]]] },
    { query: "microphone", expected: [["Interface", ["Voice"]]] },
    { query: "agent credits", expected: [["Server settings", ["Source control & issues"]]] },
    {
      query: "server settings",
      expected: [["Server settings", ["Provider accounts", "Source control & issues"]]],
    },
    {
      query: "accounts",
      expected: [["Server settings", ["Provider accounts"]]],
    },
    { query: "usage", expected: [[null, ["Usage"]]] },
    { query: "zzzz", expected: [] },
  ])("$query", ({ query, expected }) => {
    expect(visible(query)).toEqual(expected);
  });

  it("drops sections that start empty", () => {
    expect(filterSettingsSections([{ rows: [] }, ...SECTIONS], "").length).toBe(SECTIONS.length);
  });

  it("matches translated labels and their English aliases", () => {
    const sections = [{ rows: [{ id: "SettingsSkills", label: "Skills" }] }];
    const t = translateUi.bind(null, "zh-CN");
    for (const query of ["技能", "技能管理", "Skills"]) {
      expect(filterSettingsSections(sections, query, t)).toEqual(sections);
    }
    const general = [{ rows: [{ id: "SettingsOrganization", label: "General" }] }];
    for (const query of ["语言", "中文", "简体中文", "英语", "language", "locale", "English"]) {
      expect(filterSettingsSections(general, query, t)).toEqual(general);
    }
  });

  it("finds project settings by both translated and fork-specific keywords", () => {
    const sections = [{ rows: [{ id: "SettingsProjectOverview", label: "Project overview" }] }];
    const resolve = ((term: string) => {
      const options = decodeOptions(term);
      return options?.$context === "settings search keyword" && options.$_source === "checkouts"
        ? "检出目录"
        : mFallback(term);
    }) as MessageResolver;
    for (const query of ["检出目录", "checkouts", "export"]) {
      expect(filterSettingsSections(sections, query, (message) => message, resolve)).toEqual(
        sections,
      );
    }
  });
});

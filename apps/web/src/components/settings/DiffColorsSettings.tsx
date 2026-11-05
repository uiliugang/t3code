import { DIFF_COLOR_PRESETS, DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import * as Equal from "effect/Equal";

import { useUiTranslation } from "~/hooks/useUiTranslation";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const COLOR_LABELS = {
  addition: "Added files",
  deletion: "Deleted files",
  modified: "Modified files",
  conflict: "Conflicts",
} as const;
const SCHEME_LABELS = {
  "red-green": "Red & green",
  "blue-orange": "Blue & orange",
  custom: "Custom",
} as const;

export function DiffColorsSettings() {
  const t = useUiTranslation();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const colors =
    settings.diffColorScheme === "custom"
      ? settings.diffCustomColors
      : DIFF_COLOR_PRESETS[settings.diffColorScheme];
  const dirty =
    settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme ||
    !Equal.equals(settings.diffCustomColors, DEFAULT_UNIFIED_SETTINGS.diffCustomColors);

  return (
    <>
      <SettingsRow
        {...searchableSetting("diff-color-scheme")}
        description={t(
          "Choose a preset or customize colors for added, deleted, modified, and conflicted files.",
        )}
        resetAction={
          dirty ? (
            <SettingResetButton
              label={t("diff colors")}
              onClick={() =>
                updateSettings({
                  diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme,
                  diffCustomColors: DEFAULT_UNIFIED_SETTINGS.diffCustomColors,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.diffColorScheme}
            onValueChange={(value) => {
              if (value === "red-green" || value === "blue-orange" || value === "custom") {
                updateSettings({ diffColorScheme: value });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-44" aria-label={t("Diff colors")}>
              <SelectValue>{t(SCHEME_LABELS[settings.diffColorScheme])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="red-green">{t("Red & green (default)")}</SelectItem>
              <SelectItem value="blue-orange">{t("Blue & orange")}</SelectItem>
              <SelectItem value="custom">{t("Custom")}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {(Object.keys(COLOR_LABELS) as Array<keyof typeof COLOR_LABELS>).map((kind) => {
        const setColor = (color: string) =>
          updateSettings({
            diffColorScheme: "custom",
            diffCustomColors: { ...colors, [kind]: color },
          });
        return (
          <SettingsRow
            key={kind}
            title={COLOR_LABELS[kind]}
            control={
              <div className="flex w-full items-center gap-2 sm:w-44">
                <input
                  type="color"
                  value={colors[kind]}
                  aria-label={t("{label} color", { label: t(COLOR_LABELS[kind]) })}
                  className="h-8 w-9 shrink-0 cursor-pointer rounded border border-input bg-background p-1 focus-visible:outline-2 focus-visible:outline-ring"
                  onChange={(event) => setColor(event.target.value)}
                />
                <DraftInput
                  value={colors[kind]}
                  aria-label={t("{label} hex color", { label: t(COLOR_LABELS[kind]) })}
                  spellCheck={false}
                  maxLength={7}
                  pattern="#[0-9a-fA-F]{6}"
                  className="min-w-0"
                  normalizeDraft={(previous, next) =>
                    /^#?[0-9a-fA-F]{0,6}$/.test(next) ? next : previous
                  }
                  onCommit={(value) => {
                    const color = value.startsWith("#") ? value : `#${value}`;
                    if (/^#[0-9a-fA-F]{6}$/.test(color)) setColor(color);
                  }}
                />
              </div>
            }
          />
        );
      })}
    </>
  );
}

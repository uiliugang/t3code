import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useUiTranslation } from "../../hooks/useUiTranslation";

import { ScopedSwitch } from "./ScopedSwitch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function RemoteBranchDisplayDaysRow() {
  const key = "remoteBranchDisplayDays";
  const t = useUiTranslation();
  const settings = useScopedSettings();
  const mixed = useScopedSettingsMixed([key]);
  const writable = useScopedSettingsWriteAllowed();
  const update = useUpdateScopedSettings();
  const setting = searchableSetting("remote-branch-display-days");
  return (
    <SettingsRow
      serverScoped
      settingKeys={[key]}
      {...setting}
      description="Show remote branches with commits in the last N days. Default: 21 days (3 weeks). Use 0 for no age limit. Local and default branches remain visible."
      resetAction={
        mixed || settings[key] !== DEFAULT_UNIFIED_SETTINGS[key] ? (
          <SettingResetButton
            label={setting.title}
            onClick={() => update({ [key]: DEFAULT_UNIFIED_SETTINGS[key] })}
          />
        ) : null
      }
      control={
        <div className="flex w-36 items-center gap-2">
          <NumberField
            value={mixed ? null : settings[key]}
            min={0}
            step={1}
            size="sm"
            disabled={!writable}
            onValueChange={(value) => {
              if (value !== null && Number.isSafeInteger(value) && value >= 0)
                update({ [key]: value });
            }}
          >
            <NumberFieldGroup>
              <NumberFieldDecrement
                aria-label={t("Decrease {label}", { label: t(setting.title) })}
              />
              <NumberFieldInput
                aria-label={t(setting.title)}
                placeholder={mixed ? t("Mixed") : undefined}
              />
              <NumberFieldIncrement
                aria-label={t("Increase {label}", { label: t(setting.title) })}
              />
            </NumberFieldGroup>
          </NumberField>
          <span className="text-xs text-muted-foreground">{t("days")}</span>
        </div>
      }
    />
  );
}

export function HideMergedRemoteBranchesRow() {
  const key = "hideMergedRemoteBranches";
  const t = useUiTranslation();
  const settings = useScopedSettings();
  const mixed = useScopedSettingsMixed([key]);
  const update = useUpdateScopedSettings();
  const setting = searchableSetting("hide-merged-remote-branches");
  return (
    <SettingsRow
      serverScoped
      settingKeys={[key]}
      {...setting}
      description="Hide remote branches already merged into main or master. Local and default branches remain visible."
      resetAction={
        mixed || settings[key] !== DEFAULT_UNIFIED_SETTINGS[key] ? (
          <SettingResetButton
            label={setting.title}
            onClick={() => update({ [key]: DEFAULT_UNIFIED_SETTINGS[key] })}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={[key]}
          checked={settings[key]}
          onCheckedChange={(checked) => update({ [key]: Boolean(checked) })}
          aria-label={t(setting.title)}
        />
      }
    />
  );
}

export function MainBranchOnlyRow() {
  const key = "newWorktreesMainBranchOnly";
  const t = useUiTranslation();
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const setting = searchableSetting("worktree-main-branch-only");
  return (
    <SettingsRow
      serverScoped
      settingKeys={[key]}
      {...setting}
      description="Create new worktree branches only from main or master. Existing branch checkouts are unaffected."
      resetAction={
        settings[key] !== DEFAULT_UNIFIED_SETTINGS[key] ? (
          <SettingResetButton
            label={setting.title}
            onClick={() => update({ [key]: DEFAULT_UNIFIED_SETTINGS[key] })}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={[key]}
          checked={settings[key]}
          onCheckedChange={(checked) => update({ [key]: Boolean(checked) })}
          aria-label={t(setting.title)}
        />
      }
    />
  );
}

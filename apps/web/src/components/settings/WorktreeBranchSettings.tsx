import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useUiTranslation } from "../../hooks/useUiTranslation";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

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

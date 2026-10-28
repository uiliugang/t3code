import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useUiTranslation } from "../../hooks/useUiTranslation";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const BRANCH_SETTINGS = [
  {
    key: "newWorktreesMainBranchOnly",
    searchId: "worktree-main-branch-only",
    description:
      "Create new worktree branches only from main or master. Existing branch checkouts are unaffected.",
  },
  {
    key: "autoDeleteMergedBranches",
    searchId: "auto-delete-merged-branches",
    description:
      "Automatically remove local branches and worktrees merged into main or master. Keeps project checkouts, uncommitted changes, locked worktrees, and active work. Remote branches are kept.",
  },
] as const;

export function BranchManagementSettings() {
  const t = useUiTranslation();
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  return (
    <SettingsSection id="branch-management" title="Branch management">
      {BRANCH_SETTINGS.map(({ key, searchId, description }) => (
        <SettingsRow
          key={key}
          serverScoped
          settingKeys={[key]}
          {...searchableSetting(searchId)}
          description={description}
          resetAction={
            settings[key] !== DEFAULT_UNIFIED_SETTINGS[key] ? (
              <SettingResetButton
                label={searchableSetting(searchId).title}
                onClick={() => update({ [key]: DEFAULT_UNIFIED_SETTINGS[key] })}
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={[key]}
              checked={settings[key]}
              onCheckedChange={(checked) => update({ [key]: Boolean(checked) })}
              aria-label={t(searchableSetting(searchId).title)}
            />
          }
        />
      ))}
    </SettingsSection>
  );
}

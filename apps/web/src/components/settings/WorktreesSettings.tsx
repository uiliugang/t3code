import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useUiTranslation } from "../../hooks/useUiTranslation";

import { AdvancedSettings } from "./AdvancedSettings";
import { ManagedWorktreesSettings } from "./ManagedWorktreesSettings";
import { BranchNamingSettings } from "./BranchNamingSettings";
import {
  HideMergedRemoteBranchesRow,
  MainBranchOnlyRow,
  RemoteBranchDisplayDaysRow,
} from "./WorktreeBranchSettings";
import { WorktreeSubmodulesRow } from "./ProjectDefaultsSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { WorktreeCleanupSection, WorktreesDirectoryRow } from "./StorageSettings";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function StartFromRemoteRow() {
  const t = useUiTranslation();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["newWorktreesStartFromOrigin"]}
      {...searchableSetting("start-from-origin")}
      description={t(
        "Uses the latest commit of the base branch’s tracked remote branch, even if its name differs. Otherwise uses the same-named branch on origin. Uses your local branch if that remote branch is missing.",
      )}
      resetAction={
        settings.newWorktreesStartFromOrigin !==
        DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
          <SettingResetButton
            label={t("new worktrees start from remote")}
            onClick={() =>
              updateSettings({
                newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["newWorktreesStartFromOrigin"]}
          checked={settings.newWorktreesStartFromOrigin}
          onCheckedChange={(checked) =>
            updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
          }
          aria-label={t("Start new worktrees from remote by default")}
        />
      }
    />
  );
}

function SharedDependenciesRow() {
  const t = useUiTranslation();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["worktreeSharedDependencies"]}
      {...searchableSetting("worktree-shared-dependencies")}
      description={t(
        "Share pnpm packages across worktrees while keeping dependency versions independent. Applies to setup scripts and new terminals; reinstall dependencies to change existing worktrees.",
      )}
      resetAction={
        settings.worktreeSharedDependencies !==
        DEFAULT_UNIFIED_SETTINGS.worktreeSharedDependencies ? (
          <SettingResetButton
            label={t("Shared dependencies")}
            onClick={() =>
              updateSettings({
                worktreeSharedDependencies: DEFAULT_UNIFIED_SETTINGS.worktreeSharedDependencies,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["worktreeSharedDependencies"]}
          checked={settings.worktreeSharedDependencies}
          onCheckedChange={(checked) =>
            updateSettings({ worktreeSharedDependencies: Boolean(checked) })
          }
          aria-label={t("Shared dependencies")}
        />
      }
    />
  );
}

export function WorktreesSettingsPanel() {
  const t = useUiTranslation();
  const { scope } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  return (
    <SettingsPageContainer>
      <SettingsSection id="worktree-creation" title={t("Creation")}>
        {!isProjectScope && <WorktreesDirectoryRow />}
        <StartFromRemoteRow />
        <MainBranchOnlyRow />
        <SharedDependenciesRow />
        <AdvancedSettings targetIds={[searchableSetting("worktree-submodules").id]}>
          <WorktreeSubmodulesRow />
        </AdvancedSettings>
      </SettingsSection>
      <SettingsSection id="worktree-branches" title={t("Branches")}>
        <RemoteBranchDisplayDaysRow />
        <HideMergedRemoteBranchesRow />
        <BranchNamingSettings />
      </SettingsSection>
      <WorktreeCleanupSection />
      <ManagedWorktreesSettings />
    </SettingsPageContainer>
  );
}

import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useUiTranslation } from "../../../../lib/useUiTranslation";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../../../state/preferences";
import { useAtomCommand } from "../../../../state/use-atom-command";
import type { Preferences } from "../../../../persistence/mobile-preferences";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";

export function BranchIssuesSection() {
  const t = useUiTranslation();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const values = AsyncResult.getOrElse(preferences, (): Preferences => ({}));
  const update = useAtomCommand(saveMobilePreferences);
  return (
    <SettingsSection title={t("Linked issues")}>
      <SettingsSwitchRow
        label={t("Linked issues")}
        value={values.branchIssuesVisible ?? true}
        disabled={!AsyncResult.isSuccess(preferences)}
        onValueChange={(branchIssuesVisible) => void update({ branchIssuesVisible })}
      />
      <SettingsSwitchRow
        label={t("Separate card")}
        value={values.branchIssuesSeparate ?? false}
        disabled={!AsyncResult.isSuccess(preferences)}
        onValueChange={(branchIssuesSeparate) => void update({ branchIssuesSeparate })}
      />
      <SettingsSwitchRow
        label={t("Expand issue descriptions by default")}
        value={values.branchIssuesExpanded ?? false}
        disabled={!AsyncResult.isSuccess(preferences)}
        onValueChange={(branchIssuesExpanded) => void update({ branchIssuesExpanded })}
      />
      <SettingsSwitchRow
        label={t("Show when no issues are linked")}
        value={values.branchIssuesShowEmpty ?? true}
        disabled={!AsyncResult.isSuccess(preferences)}
        onValueChange={(branchIssuesShowEmpty) => void update({ branchIssuesShowEmpty })}
      />
    </SettingsSection>
  );
}

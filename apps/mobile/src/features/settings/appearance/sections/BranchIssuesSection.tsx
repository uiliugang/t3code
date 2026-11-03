import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useUiTranslation } from "../../../../lib/useUiTranslation";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../../state/preferences";
import type { Preferences } from "../../../../persistence/mobile-preferences";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";

export function BranchIssuesSection() {
  const t = useUiTranslation();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const values = AsyncResult.getOrElse(preferences, (): Preferences => ({}));
  const update = useAtomSet(updateMobilePreferencesAtom);
  return (
    <SettingsSection title={t("Linked issues")}>
      <SettingsSwitchRow
        label={t("Linked issues")}
        value={values.branchIssuesVisible ?? true}
        disabled={!AsyncResult.isSuccess(preferences)}
        onValueChange={(branchIssuesVisible) => update({ branchIssuesVisible })}
      />
      <SettingsSwitchRow
        label={t("Separate card")}
        value={values.branchIssuesSeparate ?? false}
        disabled={!AsyncResult.isSuccess(preferences)}
        onValueChange={(branchIssuesSeparate) => update({ branchIssuesSeparate })}
      />
      <SettingsSwitchRow
        label={t("Expand issue descriptions by default")}
        value={values.branchIssuesExpanded ?? false}
        disabled={!AsyncResult.isSuccess(preferences)}
        onValueChange={(branchIssuesExpanded) => update({ branchIssuesExpanded })}
      />
      <SettingsSwitchRow
        label={t("Show when no issues are linked")}
        value={values.branchIssuesShowEmpty ?? true}
        disabled={!AsyncResult.isSuccess(preferences)}
        onValueChange={(branchIssuesShowEmpty) => update({ branchIssuesShowEmpty })}
      />
    </SettingsSection>
  );
}

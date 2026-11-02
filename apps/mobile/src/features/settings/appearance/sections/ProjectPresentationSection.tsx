import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useProjectPresentation } from "../../../../lib/useProjectPresentation";
import { useUiTranslation } from "../../../../lib/useUiTranslation";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../../state/preferences";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";

export function ProjectPresentationSection() {
  const t = useUiTranslation();
  const settings = useProjectPresentation();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const update = useAtomSet(updateMobilePreferencesAtom);
  return (
    <SettingsSection title={t("Repositories & groups")}>
      <SettingsSwitchRow
        disabled={!AsyncResult.isSuccess(preferences)}
        label={t("Show repository icons")}
        value={settings.showRepositoryIcons}
        onValueChange={(showRepositoryIcons) => update({ showRepositoryIcons })}
      />
      <SettingsSwitchRow
        disabled={!AsyncResult.isSuccess(preferences)}
        label={t("Show group icons")}
        value={settings.showGroupIcons}
        onValueChange={(showGroupIcons) => update({ showGroupIcons })}
      />
      <SettingsSwitchRow
        disabled={!AsyncResult.isSuccess(preferences)}
        label={t("Capitalize repository and group names")}
        subtitle={t("Uppercase the first letter for display. Original names and paths are kept.")}
        value={settings.capitalizeProjectNames}
        onValueChange={(capitalizeProjectNames) => update({ capitalizeProjectNames })}
      />
    </SettingsSection>
  );
}

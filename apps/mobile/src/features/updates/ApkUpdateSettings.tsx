import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import * as Exit from "effect/Exit";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import {
  apkUpdateStateAtom,
  checkForApkUpdate,
  installDownloadedApkUpdate,
} from "./apk-update-runtime";

export function ApkUpdateSettings() {
  const t = useUiTranslation();
  const state = useAtomValue(apkUpdateStateAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom, { mode: "promiseExit" });
  const [saving, setSaving] = useState(false);
  const ready = AsyncResult.isSuccess(preferences);
  const enabled = ready && preferences.value.apkAutoUpdateEnabled !== false;
  const busy = state.status === "checking" || state.status === "downloading";

  const changeAutomaticUpdates = async (value: boolean) => {
    if (saving) return;
    setSaving(true);
    const result = await settlePromise(() => save({ apkAutoUpdateEnabled: value }));
    setSaving(false);
    if (result._tag === "Failure" || Exit.isFailure(result.value)) {
      Dialog.alert(t("Update failed"), t("Could not save update preferences."));
    }
  };

  const description =
    state.status === "error"
      ? t(state.message)
      : state.status === "downloading"
        ? t("Downloading {version}…", { version: state.version })
        : state.status === "ready" && state.permissionRequired
          ? t("Allow this app to install updates in Android settings, then return here.")
          : state.status === "current"
            ? t("Up to date")
            : t("Android asks you to confirm before installing an update.");
  const canInstall = state.status === "ready" || state.status === "installing";

  return (
    <SettingsSection title="App updates" footer={description}>
      <SettingsSwitchRow
        icon="arrow.down.circle"
        label={t("Automatically download APK updates")}
        value={enabled}
        disabled={!ready || saving}
        onValueChange={(value) => void changeAutomaticUpdates(value)}
      />
      <ListActionRow
        icon="arrow.clockwise"
        label={t(canInstall ? "Install downloaded update" : "Check for updates")}
        loading={busy}
        onPress={() => void (canInstall ? installDownloadedApkUpdate() : checkForApkUpdate())}
      />
    </SettingsSection>
  );
}

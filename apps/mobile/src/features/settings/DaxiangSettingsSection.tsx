import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { View } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { SettingsSection } from "./components/SettingsSection";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiTranslation } from "../../lib/useUiTranslation";

export function DaxiangSettingsSection({ environmentId }: { environmentId: EnvironmentId }) {
  const t = useUiTranslation();
  const saved = useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.daxiang;
  const canSave = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [draft, setDraft] = useState<typeof saved>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const value = draft ?? saved;
  if (!value) return null;
  return (
    <SettingsSection title="Communication">
      <View className="gap-3 p-4">
        <Text className="text-sm font-t3-medium">{t("DaXiang")}</Text>
        <ConnectionFormField
          label="Client ID"
          value={value.clientId}
          autoCapitalize="none"
          autoCorrect={false}
          editable={canSave && !busy}
          onChangeText={(clientId) => setDraft({ ...value, clientId })}
        />
        <ConnectionFormField
          label="Client Secret"
          value={value.clientSecret}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={canSave && !busy}
          onChangeText={(clientSecret) => setDraft({ ...value, clientSecret })}
        />
        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {t("Could not save DaXiang credentials.")}
          </Text>
        ) : null}
        <Button
          label={t("Save")}
          disabled={!canSave || !draft}
          loading={busy}
          onPress={() => {
            setBusy(true);
            setError(false);
            void update({
              environmentId,
              input: {
                patch: {
                  daxiang: { clientId: value.clientId.trim(), clientSecret: value.clientSecret },
                },
              },
            }).then((result) => {
              setBusy(false);
              if (result._tag === "Success") setDraft(undefined);
              else setError(true);
            });
          }}
        />
      </View>
    </SettingsSection>
  );
}

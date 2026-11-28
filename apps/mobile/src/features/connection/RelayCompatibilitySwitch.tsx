import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { relayPolicyChangedAtom } from "../../connection/relay-policy";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { useAtomCommand } from "../../state/use-atom-command";

export function RelayCompatibilitySwitch({
  environments,
}: {
  readonly environments: ReadonlyArray<ConnectedEnvironmentSummary>;
}) {
  const gt = useGT();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomCommand(saveMobilePreferences, { reportFailure: true });
  const [saving, setSaving] = useState(false);
  const ready = AsyncResult.isSuccess(preferences);
  return (
    <View className="rounded-[24px] bg-grouped-card">
      <ListToggleRow
        label={gt("Allow T3 Connect without end-to-end encryption")}
        description={gt(
          "For official and older hosts. Without end-to-end encryption, the tunnel provider can read chats, files, and terminal traffic.",
        )}
        value={ready && preferences.value.allowT3ConnectWithoutE2ee === true}
        disabled={!ready || saving}
        onValueChange={(allowed) => {
          setSaving(true);
          void save({ allowT3ConnectWithoutE2ee: allowed })
            .then((result) => {
              if (result._tag === "Success") {
                appAtomRegistry.set(
                  relayPolicyChangedAtom,
                  environments
                    .filter((entry) => entry.isEnabled)
                    .map((entry) => entry.environmentId),
                );
              }
            })
            .finally(() => setSaving(false));
        }}
      />
    </View>
  );
}

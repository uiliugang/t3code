import { useAtomValue } from "@effect/atom-react";
import { deriveAvailableInstanceId } from "@t3tools/client-runtime/provider-instance-ids";
import { isManagedDriverAllowed, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";
import { TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { SettingsTarget } from "./settings-environment-filter";

export function AddProviderConnection({ environment }: { readonly environment: SettingsTarget }) {
  const t = useUiTranslation();
  const [driver, setDriver] = useState<"codex" | "claudeAgent" | null>(null);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance);
  const allowed = useAtomValue(
    serverEnvironment.mutateProviderInstance.permissionAtom(environment.environmentId),
  );
  const create = async () => {
    if (!driver || pending || !allowed) return;
    setPending(true);
    const settings = environment.serverConfig.settings;
    const reserved = new Set([
      ...Object.keys(settings.providerInstances),
      ...["codex", "claudeAgent"].filter(
        (id) => !settings.removedProviderInstances?.includes(ProviderInstanceId.make(id)),
      ),
    ]);
    const id = deriveAvailableInstanceId(() => driver, name, reserved);
    const result = await mutate({
      environmentId: environment.environmentId,
      input: {
        patch: {},
        providerInstanceMutation: {
          operation: "create",
          instanceId: ProviderInstanceId.make(id),
          instance: {
            driver: ProviderDriverKind.make(driver),
            displayName: name.trim() || (driver === "codex" ? "Codex" : "Claude Code"),
            enabled: true,
            config:
              driver === "codex"
                ? { connectionMode: "chatgpt", runtimeSource: "auto", setupMode: "managed" }
                : {},
          },
        },
      },
    });
    setPending(false);
    if (result._tag === "Success") setDriver(null);
  };
  return (
    <View className="gap-2 p-4">
      {driver ? (
        <>
          <TextInput
            accessibilityLabel={t("Display name")}
            value={name}
            onChangeText={setName}
            editable={!pending}
            className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
          />
          <Text textRole="footnote" className="text-foreground-muted">
            {t(
              "Choose a connection method after creating the provider. Each method keeps its own settings.",
            )}
          </Text>
          <View className="flex-row gap-2">
            <ControlPill
              label={t("Add")}
              variant="primary"
              disabled={!allowed || pending}
              onPress={() => void create()}
            />
            <ControlPill label={t("Cancel")} disabled={pending} onPress={() => setDriver(null)} />
          </View>
        </>
      ) : (
        <View className="flex-row flex-wrap gap-2">
          {(["codex", "claudeAgent"] as const)
            .filter((kind) =>
              isManagedDriverAllowed(
                environment.serverConfig.managedPolicy,
                ProviderDriverKind.make(kind),
              ),
            )
            .map((kind) => (
              <ControlPill
                key={kind}
                label={t(kind === "codex" ? "Add Codex" : "Add Claude Code")}
                disabled={!allowed}
                onPress={() => {
                  setName(kind === "codex" ? "Codex" : "Claude Code");
                  setDriver(kind);
                }}
              />
            ))}
        </View>
      )}
    </View>
  );
}

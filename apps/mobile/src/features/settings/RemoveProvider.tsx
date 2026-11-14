import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ServerProvider } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";
import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { SettingsTarget } from "./settings-environment-filter";

export function RemoveProvider({
  environment,
  providers,
}: {
  readonly environment: SettingsTarget;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const t = useUiTranslation();
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, { reportFailure: false });
  const allowed = useAtomValue(
    serverEnvironment.mutateProviderInstance.permissionAtom(environment.environmentId),
  );
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported =
    environment.serverConfig.environment.capabilities.providerInstanceDeletion === true;
  if (providers.length === 0 && !error) return null;
  return (
    <View className="gap-2 p-4">
      {providers.length > 0 ? (
        <Menu
          accessibilityLabel={t("Remove provider")}
          actions={providers.map((provider) => ({
            id: provider.instanceId,
            title: provider.displayName ?? provider.driver,
            attributes: { destructive: true, disabled: pending || !allowed },
          }))}
          onPressAction={({ nativeEvent }) => {
            if (!allowed || pendingRef.current) return;
            if (!supported) {
              setError(t("Update this environment's server to remove providers."));
              return;
            }
            const provider = providers.find((entry) => entry.instanceId === nativeEvent.event);
            if (!provider) return;
            Dialog.alert(
              t("Remove {name}?", { name: provider.displayName ?? provider.driver }),
              t(
                "Active sessions will be stopped. Saved settings and unused T3-managed resources will be removed. Personal CLI installations and configuration will be kept.",
              ),
              [
                { text: t("Cancel"), style: "cancel" },
                {
                  text: t("Remove"),
                  style: "destructive",
                  onPress: () => {
                    if (pendingRef.current) return;
                    pendingRef.current = true;
                    setPending(true);
                    setError(null);
                    void mutate({
                      environmentId: environment.environmentId,
                      input: {
                        patch: {},
                        providerInstanceMutation: {
                          operation: "delete",
                          instanceId: provider.instanceId,
                        },
                      },
                    }).then((result) => {
                      pendingRef.current = false;
                      setPending(false);
                      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                        const failure = squashAtomCommandFailure(result);
                        setError(
                          failure instanceof Error
                            ? failure.message
                            : t("Could not delete provider instance"),
                        );
                      }
                    });
                  },
                },
              ],
            );
          }}
        >
          <ControlPill label={t("Remove provider")} disabled={pending || !allowed} />
        </Menu>
      ) : null}
      {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
    </View>
  );
}

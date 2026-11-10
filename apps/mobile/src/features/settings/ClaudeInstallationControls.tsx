import { useAtomValue } from "@effect/atom-react";
import type { ServerProvider } from "@t3tools/contracts";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { SettingsTarget } from "./settings-environment-filter";

export function ClaudeInstallationControls({
  environment,
  provider,
}: {
  readonly environment: SettingsTarget;
  readonly provider: ServerProvider;
}) {
  const t = useUiTranslation();
  const instance = {
    driver: provider.driver,
    ...environment.serverConfig.settings.providerInstances[provider.instanceId],
  };
  const config =
    instance?.config !== null && typeof instance?.config === "object" ? instance.config : {};
  const managed = "setupMode" in config && config.setupMode === "managed";
  const environmentId = environment.environmentId;
  const target = { environmentId, input: { instanceId: provider.instanceId } };
  const installation = useEnvironmentQuery(
    managed ? serverEnvironment.providerInstallState(target) : null,
  );
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance);
  const start = useAtomCommand(serverEnvironment.startProviderInstall);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderInstall);
  const remove = useAtomCommand(serverEnvironment.removeProviderInstallation);
  const canMutate = useAtomValue(
    serverEnvironment.mutateProviderInstance.permissionAtom(environmentId),
  );
  const canStart = useAtomValue(
    serverEnvironment.startProviderInstall.permissionAtom(environmentId),
  );
  const canCancel = useAtomValue(
    serverEnvironment.cancelProviderInstall.permissionAtom(environmentId),
  );
  const canRemove = useAtomValue(
    serverEnvironment.removeProviderInstallation.permissionAtom(environmentId),
  );
  const state = installation.data;
  const active =
    state?.phase === "downloading" || state?.phase === "extracting" || state?.phase === "verifying";
  return (
    <View className="gap-2 border-t border-border-subtle px-4 py-3">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text textRole="body" className="shrink text-foreground">
          {t("{name} installation", { name: provider.displayName ?? "Claude" })}
        </Text>
        <Menu
          actions={[
            { id: "existing", title: t("Use local installation"), state: managed ? "off" : "on" },
            { id: "managed", title: t("Managed by T3"), state: managed ? "on" : "off" },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (!canMutate || active) return;
            const setupMode = nativeEvent.event;
            if (setupMode !== "existing" && setupMode !== "managed") return;
            void mutate({
              environmentId,
              input: {
                patch: {},
                providerInstanceMutation: {
                  operation: "upsert",
                  instanceId: provider.instanceId,
                  instance: { ...instance, config: { ...config, setupMode } },
                },
              },
            });
          }}
        >
          <ControlPill
            label={t(managed ? "Managed by T3" : "Use local installation")}
            disabled={!canMutate || active}
          />
        </Menu>
      </View>
      {managed ? (
        <>
          {installation.error || state?.message ? (
            <Text textRole="footnote" className="text-foreground-muted">
              {state?.message ?? t("Could not read installation status. Reconnect and try again.")}
            </Text>
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            {active ? (
              <ControlPill
                label={t("Cancel installation")}
                disabled={!canCancel || !state.operationId}
                onPress={() => {
                  if (state.operationId)
                    void cancel({
                      environmentId,
                      input: { instanceId: provider.instanceId, operationId: state.operationId },
                    });
                }}
              />
            ) : (
              <>
                <ControlPill
                  label={t(provider.installed ? "Update Claude" : "Install Claude")}
                  disabled={!canStart || !provider.setup?.canInstall}
                  onPress={() => void start(target)}
                />
                {state?.canRemove ? (
                  <ControlPill
                    label={t("Remove installation")}
                    disabled={!canRemove}
                    onPress={() => void remove(target)}
                  />
                ) : null}
              </>
            )}
          </View>
        </>
      ) : null}
    </View>
  );
}

import { isClaudeByok } from "@t3tools/shared/claudeByok";
import { codexConnectionMode, codexRuntimeSource } from "@t3tools/shared/codexByok";
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
  connectionDisabled = false,
}: {
  readonly environment: SettingsTarget;
  readonly provider: ServerProvider;
  readonly connectionDisabled?: boolean;
}) {
  const t = useUiTranslation();
  const instance = {
    driver: provider.driver,
    ...environment.serverConfig.settings.providerInstances[provider.instanceId],
  };
  const config =
    instance?.config !== null && typeof instance?.config === "object" ? instance.config : {};
  const codex = provider.driver === "codex";
  const source = codexRuntimeSource(config);
  const connection = codex
    ? codexConnectionMode(config)
    : isClaudeByok(config)
      ? "byok"
      : "existing";
  const profiles = environment.serverConfig.environment.capabilities?.providerConnectionProfiles;
  const managed = codex
    ? codexRuntimeSource(config) === "managed"
    : "setupMode" in config && config.setupMode === "managed";
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
      {codex || profiles ? (
        <View className="flex-row flex-wrap items-center justify-between gap-2">
          <Text textRole="body">{t("Connection method")}</Text>
          <Menu
            actions={[
              ...(codex
                ? [
                    {
                      id: "chatgpt",
                      title: t("ChatGPT account"),
                      state: connection === "chatgpt" ? ("on" as const) : ("off" as const),
                    },
                  ]
                : []),
              {
                id: "existing",
                title: t(codex ? "Use existing CLI" : "Claude account / existing CLI"),
                state: connection === "existing" ? "on" : "off",
              },
              { id: "byok", title: t("API Key"), state: connection === "byok" ? "on" : "off" },
            ]}
            onPressAction={({ nativeEvent }) => {
              const mode = nativeEvent.event;
              if (
                !canMutate ||
                connectionDisabled ||
                active ||
                (mode !== "chatgpt" && mode !== "existing" && mode !== "byok")
              )
                return;
              void mutate({
                environmentId,
                input: {
                  patch: {},
                  providerInstanceMutation: profiles
                    ? {
                        operation: "switch-connection",
                        instanceId: provider.instanceId,
                        connectionMode: mode,
                        expectedConnectionMode: connection,
                      }
                    : {
                        operation: "upsert",
                        instanceId: provider.instanceId,
                        instance: {
                          ...instance,
                          config: {
                            ...config,
                            connectionMode: mode,
                            runtimeSource: source,
                            setupMode: mode === "chatgpt" ? "managed" : "existing",
                          },
                        },
                      },
                },
              });
            }}
          >
            <ControlPill
              label={t(
                connection === "chatgpt"
                  ? "ChatGPT account"
                  : connection === "byok"
                    ? "API Key"
                    : codex
                      ? "Use existing CLI"
                      : "Claude account / existing CLI",
              )}
              disabled={!canMutate || active || connectionDisabled}
            />
          </Menu>
        </View>
      ) : null}
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text textRole="body" className="shrink text-foreground">
          {t("{name} installation", { name: provider.displayName ?? "Claude" })}
        </Text>
        <Menu
          actions={[
            ...(codex
              ? [
                  {
                    id: "auto",
                    title: t("Automatic"),
                    state: source === "auto" ? ("on" as const) : ("off" as const),
                  },
                ]
              : []),
            {
              id: "existing",
              title: t("Use local installation"),
              state: (codex ? source === "local" : !managed) ? "on" : "off",
            },
            { id: "managed", title: t("Managed by T3"), state: managed ? "on" : "off" },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (!canMutate || active) return;
            const setupMode = nativeEvent.event;
            if (
              setupMode !== "existing" &&
              setupMode !== "managed" &&
              !(codex && setupMode === "auto")
            )
              return;
            void mutate({
              environmentId,
              input: {
                patch: {},
                providerInstanceMutation: {
                  operation: "upsert",
                  instanceId: provider.instanceId,
                  instance: {
                    ...instance,
                    config: codex
                      ? {
                          ...config,
                          connectionMode: codexConnectionMode(config),
                          runtimeSource: setupMode === "existing" ? "local" : setupMode,
                          setupMode:
                            codexConnectionMode(config) === "chatgpt" ? "managed" : "existing",
                        }
                      : { ...config, setupMode },
                  },
                },
              },
            });
          }}
        >
          <ControlPill
            label={t(
              codex && source === "auto"
                ? "Automatic"
                : managed
                  ? "Managed by T3"
                  : "Use local installation",
            )}
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
                  label={t(
                    codex
                      ? "Install / update"
                      : provider.installed
                        ? "Update Claude"
                        : "Install Claude",
                  )}
                  disabled={!canStart || (!codex && !provider.setup?.canInstall)}
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

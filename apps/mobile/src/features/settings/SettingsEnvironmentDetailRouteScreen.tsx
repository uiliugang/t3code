import { WechatSettingsSection } from "./WechatSettingsSection";
import { useUiTranslation } from "../../lib/useUiTranslation";
import * as Dialog from "../../components/ui/Dialog";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthOrchestrationReadScope,
  managedUpdatesDenial,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { sessionPermissionsUnavailableMessage } from "@t3tools/shared/authScopeOptions";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { Linking, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { environmentSession, useEnvironmentScope, readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { ConnectionEnvironmentRow } from "../connection/ConnectionEnvironmentRow";
import { EnvironmentRoutesSection } from "./EnvironmentRoutesSection";
import { DaxiangSettingsSection } from "./DaxiangSettingsSection";
import { OutdatedServerUpdateSection } from "./OutdatedServerUpdateSection";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  canMaintainEnvironment,
  canUpdateEnvironmentProvider,
  supportsEnvironmentUpdate,
} from "./environment-maintenance";
import { environmentReleaseCheckAtom, releaseCheckValue } from "./environmentUpdateCheck";

export function SettingsEnvironmentDetailRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
}>) {
  return (
    <EnvironmentDetail
      key={route.params.environmentId}
      environmentId={route.params.environmentId}
    />
  );
}

function EnvironmentDetail({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const t = useUiTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const connections = useRemoteConnections();
  const environment = connections.connectedEnvironments.find(
    (entry) => entry.environmentId === environmentId,
  );
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const session = useAtomValue(environmentSession.sessionStateValueAtom(environmentId));
  const sessionResult = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const updateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const outdated =
    useAtomValue(environmentPresentations.presentationAtom(environmentId))?.entry
      .serverUpdateRequired === true;
  const updateServer = useAtomCommand(serverEnvironment.updateServer);
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider);
  const renameEnvironment = useAtomCommand(serverEnvironment.updateSettings, {
    label: "rename environment",
    reportFailure: true,
  });
  const canRename =
    useEnvironmentScope(environmentId, AuthSettingsWriteScope) &&
    config?.environment.capabilities.environmentName === true;
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const savedName = config?.settings.environmentName ?? "";
  const nameValue = nameDraft ?? savedName;
  const saveName = async (environmentName: string | null) => {
    if (!canRename || renaming) return;
    setRenaming(true);
    const result = await renameEnvironment({
      environmentId,
      input: { patch: { environmentName } },
    });
    setRenaming(false);
    if (result._tag === "Success") setNameDraft(null);
  };
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders);
  const [connectionExpanded, setConnectionExpanded] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [releaseCheck, checkRelease] = useAtom(environmentReleaseCheckAtom(environmentId), {
    mode: "promiseExit",
  });
  const release = releaseCheckValue(releaseCheck);

  const connected = environment?.isEnabled === true && environment.connectionState === "connected";
  const allowed =
    !AsyncResult.isFailure(sessionResult) && canMaintainEnvironment(session, connected);
  const running = updateState.status === "running";
  const providerBusy =
    config?.providers.some(
      (provider) =>
        provider.updateState?.status === "running" || provider.updateState?.status === "queued",
    ) ?? false;
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const busy = !connected || pending !== null || running || providerBusy;
  const disabled = !allowed || busy;
  const version = config?.environment.serverVersion;
  const checkedRelease = release?.fromVersion === version ? release : null;
  const capabilities = config?.environment.capabilities;
  const managedPolicy = config?.managedPolicy;
  const supportUrl = managedPolicy?.supportUrl;
  // The server refuses checks and installs; say so instead of offering them.
  const updatesDenial = managedUpdatesDenial(managedPolicy);

  async function run(label: string, action: () => Promise<void>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(label);
    setError(null);
    setNotice(null);
    const result = await settlePromise(action);
    pendingRef.current = false;
    setPending(null);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error ? cause.message : "The action could not be completed. Try again.",
      );
    }
  }

  function requestServerUpdate() {
    const targetVersion = checkedRelease?.targetVersion;
    if (disabled || !targetVersion || !capabilities || !supportsEnvironmentUpdate(capabilities))
      return;
    Dialog.alert(
      t("Update {name}?", { name: environment?.environmentLabel ?? t("Environment") }),
      `${t("Install T3 Code {version}.", { version: targetVersion })} ${t(capabilities.serverSelfUpdate === "desktop-managed" ? "The desktop app will close and relaunch." : "The server will restart and reconnect.")} ${t("Running threads may be interrupted.")}`,
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Update"),
          onPress: () =>
            void run("server", async () => {
              if (
                AsyncResult.isFailure(
                  appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId)),
                ) ||
                !canMaintainEnvironment(
                  appAtomRegistry.get(environmentSession.sessionStateValueAtom(environmentId)),
                  connected,
                )
              )
                return;
              const result = await updateServer({
                environmentId,
                input: { targetVersion },
              });
              if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
              setNotice(t("Updated to {version}.", { version: result.value.targetVersion }));
            }),
        },
      ],
    );
  }

  function requestProviderUpdate(provider: ServerProvider) {
    if (
      busy ||
      !readEnvironmentScope(environmentId, AuthProvidersManageScope) ||
      !canUpdateEnvironmentProvider(provider)
    )
      return;
    void run(provider.instanceId, async () => {
      const result = await updateProvider({
        environmentId,
        input: {
          provider: provider.driver,
          instanceId: provider.instanceId,
        },
      });
      if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
    });
  }

  return (
    <SettingsScreen title={environment?.environmentLabel ?? t("Environment")}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!environment ? (
          <Text className="text-base text-foreground-muted">
            {t("This environment is no longer saved on this device.")}
          </Text>
        ) : (
          <>
            <SettingsSection title={t("Connection")}>
              <ConnectionEnvironmentRow
                environment={environment}
                expanded={connectionExpanded}
                onToggle={() => setConnectionExpanded((value) => !value)}
                onReconnect={connections.onReconnectEnvironment}
                onRemove={connections.onRemoveEnvironmentPress}
                onSetEnabled={connections.onSetEnvironmentEnabled}
                onUpdate={connections.onUpdateEnvironment}
              />
            </SettingsSection>
            {connected && canRename ? (
              <SettingsSection title={t("Environment name")}>
                <View className="gap-3 p-4">
                  <AppTextInput
                    accessibilityLabel={t("Environment name")}
                    value={nameValue}
                    placeholder={config?.environment.defaultLabel ?? config?.environment.label}
                    maxLength={100}
                    editable={!renaming}
                    onChangeText={setNameDraft}
                    className="min-h-10 rounded-lg border border-border px-3 py-2 text-base text-foreground"
                  />
                  <View className="flex-row flex-wrap gap-2">
                    <Button
                      label={t("Save")}
                      size="compact"
                      loading={renaming}
                      disabled={!nameValue.trim() || nameValue.trim() === savedName}
                      onPress={() => void saveName(nameValue.trim())}
                    />
                    <Button
                      label={t("Restore default name")}
                      size="compact"
                      disabled={renaming || savedName === ""}
                      onPress={() => void saveName(null)}
                    />
                  </View>
                </View>
              </SettingsSection>
            ) : null}
            {connected && !outdated ? (
              <>
                <DaxiangSettingsSection environmentId={environmentId} />
                <WechatSettingsSection environmentId={environmentId} />
              </>
            ) : null}
            <EnvironmentRoutesSection
              environmentId={environmentId}
              connected={connected}
              onAddRoute={() =>
                navigation.navigate("SettingsEnvironmentNew", { routeFor: environmentId })
              }
            />
            {outdated ? (
              <OutdatedServerUpdateSection
                environmentId={environmentId}
                label={environment.environmentLabel}
              />
            ) : !connected ? (
              <Text className="px-2 text-sm text-foreground-muted">
                {t("Connect this environment to manage it.")}
              </Text>
            ) : !allowed ? (
              <Text className="px-2 text-sm text-foreground-muted">
                {t(
                  AsyncResult.isFailure(sessionResult) || session === null || !session.authenticated
                    ? sessionPermissionsUnavailableMessage({
                        connected,
                        failed: AsyncResult.isFailure(sessionResult),
                        rejected:
                          !AsyncResult.isFailure(sessionResult) && session?.authenticated === false,
                      })
                    : "This connection does not have permission to manage the environment.",
                )}
              </Text>
            ) : null}
            {error ? (
              <Text selectable className="px-2 text-sm text-danger-foreground">
                {t(error)}
              </Text>
            ) : null}
            {notice ? <Text className="px-2 text-sm text-foreground-muted">{notice}</Text> : null}
            {config && !outdated ? (
              <>
                <SettingsSection title="T3 Code">
                  <View className="gap-1 p-4">
                    <Text className="text-base text-foreground">
                      {t("Version")}
                      {version}
                    </Text>
                    {managedPolicy ? (
                      <Text className="text-sm text-foreground-muted">
                        {t("Managed by")}
                        {managedPolicy.organization}
                      </Text>
                    ) : null}
                    {updatesDenial ? (
                      <Text className="text-sm text-foreground-muted">{t(updatesDenial)}</Text>
                    ) : null}
                    {running ? (
                      <Text className="text-sm text-foreground-muted">
                        {t(
                          updateState.stage === "resuming"
                            ? "Restarting and reconnecting…"
                            : "Downloading update…",
                        )}
                      </Text>
                    ) : updateState.status === "failed" ? (
                      <Text selectable className="text-sm text-danger-foreground">
                        {t(updateState.message)}
                      </Text>
                    ) : null}
                    {checkedRelease && !updatesDenial ? (
                      <Text className="text-sm text-foreground-muted">
                        {checkedRelease.targetVersion
                          ? t("Version {version} is available.", {
                              version: checkedRelease.targetVersion,
                            })
                          : t("You are up to date.")}
                      </Text>
                    ) : null}
                    {checkedRelease?.targetVersion &&
                    !updatesDenial &&
                    !supportsEnvironmentUpdate(config.environment.capabilities) ? (
                      <Text className="text-sm text-foreground-muted">
                        {t(
                          capabilities?.serverSelfUpdate === "desktop-managed"
                            ? "Update the desktop app on this machine."
                            : "Update and restart T3 Code on this machine.",
                        )}
                      </Text>
                    ) : null}
                  </View>
                  {supportUrl ? (
                    <SettingsActionRow
                      icon="questionmark.bubble"
                      label={t("Get help from {organization}", {
                        organization: managedPolicy.organization,
                      })}
                      onPress={() => void Linking.openURL(supportUrl).catch(() => undefined)}
                    />
                  ) : null}
                  {updatesDenial ? null : (
                    <SettingsActionRow
                      icon="arrow.clockwise"
                      label={t("Check for updates")}
                      disabled={disabled}
                      loading={pending === "check"}
                      onPress={() => {
                        if (disabled) return;
                        const fromVersion = config.environment.serverVersion;
                        void run("check", async () => {
                          const exit = await checkRelease(async () => fromVersion);
                          // `run` owns the error message, so a failed lookup rethrows to it.
                          if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
                        });
                      }}
                    />
                  )}
                  {checkedRelease?.targetVersion &&
                  !updatesDenial &&
                  supportsEnvironmentUpdate(config.environment.capabilities) ? (
                    <SettingsActionRow
                      icon="arrow.up.circle"
                      label={t("Update to {version}", { version: checkedRelease.targetVersion })}
                      disabled={disabled}
                      loading={pending === "server" || running}
                      onPress={requestServerUpdate}
                    />
                  ) : null}
                </SettingsSection>
                <SettingsSection title={t("Providers")}>
                  <SettingsActionRow
                    icon="arrow.clockwise"
                    label={t("Refresh providers")}
                    disabled={busy || !canRead}
                    loading={pending === "refresh"}
                    onPress={() => {
                      if (busy || !canRead) return;
                      void run("refresh", async () => {
                        if (!readEnvironmentScope(environmentId, AuthOrchestrationReadScope))
                          return;
                        const result = await refreshProviders({
                          environmentId,
                          input: { reloadSecrets: true },
                        });
                        if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
                        setNotice(t("Provider status refreshed."));
                      });
                    }}
                  />
                  {config.providers
                    .filter((provider) => provider.enabled)
                    .map((provider) => (
                      <View key={provider.instanceId}>
                        <View className="gap-1 p-4">
                          <View className="flex-row items-center gap-2">
                            <ProviderIcon
                              provider={provider.driver}
                              iconUrl={provider.iconUrl}
                              size={18}
                            />
                            <Text className="min-w-0 flex-1 text-base font-t3-medium text-foreground">
                              {provider.displayName ?? provider.driver}
                            </Text>
                          </View>
                          <Text className="text-sm text-foreground-muted">
                            {provider.installed
                              ? (provider.version ?? t("Version unknown"))
                              : t("Not installed")}
                            {provider.versionAdvisory?.latestVersion
                              ? ` · ${t("Latest {version}", { version: provider.versionAdvisory.latestVersion })}`
                              : ""}
                          </Text>
                          {provider.updateState && provider.updateState.status !== "idle" ? (
                            <Text
                              selectable
                              className={
                                provider.updateState.status === "failed"
                                  ? "text-sm text-danger-foreground"
                                  : "text-sm text-foreground-muted"
                              }
                            >
                              {provider.updateState.message
                                ? t(provider.updateState.message)
                                : t("Update {status}", { status: t(provider.updateState.status) })}
                            </Text>
                          ) : null}
                          {provider.compatibilityAdvisory?.message ? (
                            <Text selectable className="text-sm text-foreground-muted">
                              {t(provider.compatibilityAdvisory.message)}
                            </Text>
                          ) : null}
                          {provider.unavailableReason || provider.message ? (
                            <Text selectable className="text-sm text-foreground-muted">
                              {t(provider.unavailableReason ?? provider.message ?? "")}
                            </Text>
                          ) : null}
                          {provider.versionAdvisory?.status === "behind_latest" &&
                          !provider.versionAdvisory.canUpdate ? (
                            <Text className="text-sm text-foreground-muted">
                              {t("Update this provider on the environment's machine.")}
                            </Text>
                          ) : null}
                        </View>
                        {canUpdateEnvironmentProvider(provider) ? (
                          <SettingsActionRow
                            icon="arrow.up.circle"
                            label={t("Update {name}", {
                              name: provider.displayName ?? provider.driver,
                            })}
                            disabled={busy || !canManageProviders}
                            loading={pending === provider.instanceId}
                            onPress={() => requestProviderUpdate(provider)}
                          />
                        ) : null}
                      </View>
                    ))}
                </SettingsSection>
              </>
            ) : null}
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

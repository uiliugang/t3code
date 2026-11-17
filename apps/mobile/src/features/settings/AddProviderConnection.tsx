import { useAtomValue } from "@effect/atom-react";
import { deriveAvailableInstanceId } from "@t3tools/client-runtime/provider-instance-ids";
import {
  isManagedDriverAllowed,
  isManagedSettingPath,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { KeyboardSheetBody } from "../../components/ui/KeyboardSheetBody";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { Sheet } from "../../components/ui/Sheet";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { SettingsTarget } from "./settings-environment-filter";
import { AddClaudeAccount } from "./ClaudeAccounts";
import { ClaudeByokProviderSettings } from "./ClaudeByokProviderSettings";

export function AddProviderConnection({
  environment,
  providers,
}: {
  readonly environment: SettingsTarget;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const t = useUiTranslation();
  const [expanded, setExpanded] = useState(false);
  const [driver, setDriver] = useState<"codex" | "claudeAgent" | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [pendingToggle, setPendingToggle] = useState<{
    instanceId: ProviderInstanceId;
    enabled: boolean;
  } | null>(null);
  const pending = creating || pendingToggle !== null;
  const pendingRef = useRef(false);
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance);
  const allowed = useAtomValue(
    serverEnvironment.mutateProviderInstance.permissionAtom(environment.environmentId),
  );
  const unified =
    environment.serverConfig.environment.capabilities?.providerConnectionProfiles === true;
  const canAddClaude = isManagedDriverAllowed(
    environment.serverConfig.managedPolicy,
    ProviderDriverKind.make("claudeAgent"),
  );
  const canAddCodex = isManagedDriverAllowed(
    environment.serverConfig.managedPolicy,
    ProviderDriverKind.make("codex"),
  );
  const availableProviders = providers.filter((provider) =>
    isManagedDriverAllowed(environment.serverConfig.managedPolicy, provider.driver),
  );
  const setProviderEnabled = async (provider: ServerProvider, enabled: boolean) => {
    if (
      pendingRef.current ||
      !allowed ||
      isManagedSettingPath(
        environment.serverConfig.managedPolicy,
        `providerInstances.${provider.instanceId}.enabled`,
      )
    )
      return;
    pendingRef.current = true;
    setPendingToggle({ instanceId: provider.instanceId, enabled });
    await mutate({
      environmentId: environment.environmentId,
      input: {
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: provider.instanceId,
          instance: {
            driver: provider.driver,
            ...environment.serverConfig.settings.providerInstances[provider.instanceId],
            enabled,
          },
        },
      },
    });
    pendingRef.current = false;
    setPendingToggle(null);
  };
  const create = async () => {
    if (!driver || pendingRef.current || !allowed) return;
    pendingRef.current = true;
    setCreating(true);
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
    pendingRef.current = false;
    setCreating(false);
    if (result._tag === "Success") {
      setDriver(null);
      setExpanded(false);
    }
  };
  const close = () => {
    setExpanded(false);
    setDriver(null);
    setName("");
  };
  return (
    <>
      <Pressable
        accessibilityLabel={t("Add provider")}
        accessibilityRole="button"
        accessibilityState={{ disabled: !allowed || pending }}
        disabled={!allowed || pending}
        onPress={() => setExpanded(true)}
        className="size-[44px] items-center justify-center active:opacity-70"
      >
        <View
          className={`size-8 items-center justify-center rounded-full ${!allowed || pending ? "bg-subtle-strong" : "bg-primary"}`}
        >
          <SymbolView
            name="plus"
            size={18}
            tintColorClassName={
              !allowed || pending ? "accent-icon-subtle" : "accent-primary-foreground"
            }
          />
        </View>
      </Pressable>
      {expanded ? (
        <Sheet title={t("Add provider")} onClose={close} dismissDisabled={pending} expanded>
          <KeyboardSheetBody>
            <ScreenScrollView
              className="flex-1"
              contentContainerClassName="gap-2 pb-2"
              contentInsetAdjustmentBehavior="never"
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
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
                    <ControlPill
                      label={t("Cancel")}
                      disabled={pending}
                      onPress={() => setDriver(null)}
                    />
                  </View>
                </>
              ) : (
                <>
                  <ListSection>
                    {unified ? (
                      <View>
                        {(["codex", "claudeAgent"] as const)
                          .filter((kind) =>
                            isManagedDriverAllowed(
                              environment.serverConfig.managedPolicy,
                              ProviderDriverKind.make(kind),
                            ),
                          )
                          .map((kind, index) => (
                            <View
                              key={kind}
                              className={index > 0 ? "border-t border-border-subtle" : undefined}
                            >
                              <ListActionRow
                                trailingIcon="plus"
                                label={t(kind === "codex" ? "Add Codex" : "Add Claude Code")}
                                disabled={!allowed || pending}
                                onPress={() => {
                                  setName(kind === "codex" ? "Codex" : "Claude Code");
                                  setDriver(kind);
                                }}
                              />
                            </View>
                          ))}
                      </View>
                    ) : (
                      <>
                        {canAddClaude ? (
                          <>
                            <AddClaudeAccount environment={environment} />
                            <ClaudeByokProviderSettings environment={environment} createOnly />
                          </>
                        ) : null}
                        {canAddCodex &&
                        environment.serverConfig.environment.capabilities?.codexByok ? (
                          <ClaudeByokProviderSettings
                            environment={environment}
                            driver="codex"
                            createOnly
                          />
                        ) : null}
                      </>
                    )}
                    {availableProviders.map((provider) => (
                      <View key={provider.instanceId} className="border-t border-border-subtle">
                        <ListToggleRow
                          label={provider.displayName ?? provider.driver}
                          value={
                            pendingToggle?.instanceId === provider.instanceId
                              ? pendingToggle.enabled
                              : provider.enabled
                          }
                          disabled={
                            !allowed ||
                            pending ||
                            isManagedSettingPath(
                              environment.serverConfig.managedPolicy,
                              `providerInstances.${provider.instanceId}.enabled`,
                            )
                          }
                          onValueChange={(value) => void setProviderEnabled(provider, value)}
                        />
                      </View>
                    ))}
                  </ListSection>
                  <ControlPill label={t("Cancel")} disabled={pending} onPress={close} />
                </>
              )}
            </ScreenScrollView>
          </KeyboardSheetBody>
        </Sheet>
      ) : null}
    </>
  );
}

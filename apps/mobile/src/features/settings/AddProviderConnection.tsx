import { useAtomValue } from "@effect/atom-react";
import { deriveAvailableInstanceId } from "@t3tools/client-runtime/provider-instance-ids";
import { providerClients } from "@t3tools/client-runtime/provider-clients";
import {
  isManagedDriverAllowed,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { ProviderIcon } from "../../components/ProviderIcon";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { KeyboardSheetBody } from "../../components/ui/KeyboardSheetBody";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
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
  onCreated,
}: {
  readonly environment: SettingsTarget;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onCreated?: () => void;
}) {
  const t = useUiTranslation();
  const [expanded, setExpanded] = useState(false);
  const [driver, setDriver] = useState<ProviderDriverKind | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const pending = creating;
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
  const availableDrivers = providerClients.definitions.filter(
    (definition) =>
      definition.hasDefaultInstance !== false &&
      (unified || !["codex", "claudeAgent"].includes(definition.driverKind)) &&
      isManagedDriverAllowed(environment.serverConfig.managedPolicy, definition.driverKind),
  );
  const driverLabel =
    driver === "claudeAgent"
      ? "Claude Code"
      : (providerClients.get(driver ?? undefined)?.label ?? "");
  const create = async () => {
    if (!driver || pendingRef.current || !allowed) return;
    pendingRef.current = true;
    setCreating(true);
    const settings = environment.serverConfig.settings;
    const reserved = new Set([
      ...Object.keys(settings.providerInstances),
      ...providers.map((provider) => provider.instanceId),
      ...providerClients.definitions
        .filter((definition) => definition.hasDefaultInstance !== false)
        .map((definition) => definition.driverKind)
        .filter((id) => !settings.removedProviderInstances?.includes(ProviderInstanceId.make(id))),
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
            displayName: name.trim() || driverLabel,
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
      onCreated?.();
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
        <Sheet
          title={driver ? driverLabel : t("Add provider")}
          onClose={close}
          dismissDisabled={pending}
          expanded
        >
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
                  {driver === "codex" || driver === "claudeAgent" ? (
                    <Text textRole="footnote" className="text-foreground-muted">
                      {t(
                        "Choose a connection method after creating the provider. Each method keeps its own settings.",
                      )}
                    </Text>
                  ) : null}
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
                    {!unified ? (
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
                    ) : null}
                    {availableDrivers.map((definition, index) => {
                      const label =
                        definition.driverKind === "claudeAgent" ? "Claude Code" : definition.label;
                      return (
                        <View
                          key={definition.driverKind}
                          className={
                            index > 0 || !unified ? "border-t border-border-subtle" : undefined
                          }
                        >
                          <ListActionRow
                            leading={<ProviderIcon provider={definition.driverKind} size={22} />}
                            trailingIcon="plus"
                            label={label}
                            disabled={!allowed || pending}
                            onPress={() => {
                              setName(label);
                              setDriver(definition.driverKind);
                            }}
                          />
                        </View>
                      );
                    })}
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

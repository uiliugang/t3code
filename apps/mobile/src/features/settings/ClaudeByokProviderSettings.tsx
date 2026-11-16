import {
  codexConnectionMode,
  codexRuntimeSource,
  codexByokUrlError,
  withCodexByokVariable,
  CODEX_BYOK_LABEL,
} from "@t3tools/shared/codexByok";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { TextInput, View } from "react-native";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  CLAUDE_BYOK_LABEL,
  CLAUDE_BYOK_PROTOCOL_VARIABLE,
  readClaudeByokProtocol,
  claudeByokAuthVariable,
  claudeByokUrlError,
  isClaudeByok,
  readClaudeByokAuthMode,
  withClaudeByokVariable,
} from "@t3tools/shared/claudeByok";
import { readCustomModelEntries, toCustomModelSetting } from "@t3tools/shared/model";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { ListRow } from "../../components/ui/ListRow";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Menu } from "../../components/ui/Menu";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiTranslation } from "../../lib/useUiTranslation";
import type { SettingsTarget } from "./settings-environment-filter";
import { ClaudeInstallationControls } from "./ClaudeInstallationControls";

export function ClaudeByokProviderSettings({
  environment,
  driver = "claudeAgent",
  allowCreate = true,
  providers = [],
  showDisabled = false,
}: {
  readonly allowCreate?: boolean;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly showDisabled?: boolean;
  readonly driver?: "claudeAgent" | "codex";
  readonly environment: SettingsTarget;
}) {
  const t = useUiTranslation();
  const label = driver === "codex" ? CODEX_BYOK_LABEL : CLAUDE_BYOK_LABEL;
  const [adding, setAdding] = useState(false);
  const instances = Object.entries(environment.serverConfig.settings.providerInstances).filter(
    ([instanceId, instance]) =>
      instance.driver === driver &&
      (showDisabled ||
        (providers.find((provider) => provider.instanceId === instanceId)?.enabled ??
          instance.enabled ??
          true)) &&
      (driver === "codex"
        ? codexConnectionMode(instance.config) === "byok"
        : isClaudeByok(instance.config)),
  );
  const existing = new Set(Object.keys(environment.serverConfig.settings.providerInstances));
  let id = `${driver}_byok`;
  for (let suffix = 2; existing.has(id); suffix++) id = `${driver}_byok_${suffix}`;
  return (
    <View>
      {instances.map(([instanceId, instance]) => (
        <ClaudeByokEditor
          driver={driver}
          key={`${instanceId}:${JSON.stringify(instance.environment)}`}
          environment={environment}
          instanceId={ProviderInstanceId.make(instanceId)}
          instance={instance}
          provider={providers.find((provider) => provider.instanceId === instanceId)}
        />
      ))}
      {adding ? (
        <ClaudeByokEditor
          driver={driver}
          environment={environment}
          instanceId={ProviderInstanceId.make(id)}
          onClose={() => setAdding(false)}
        />
      ) : allowCreate ? (
        <ListActionRow
          icon="plus"
          label={t("Add {name}", { name: label })}
          onPress={() => setAdding(true)}
        />
      ) : null}
    </View>
  );
}

function ClaudeByokEditor({
  driver,
  environment,
  instanceId,
  instance,
  provider,
  onClose,
}: {
  readonly environment: SettingsTarget;
  readonly driver: "claudeAgent" | "codex";
  readonly instanceId: ProviderInstanceId;
  readonly instance?: ProviderInstanceConfig;
  readonly provider?: ServerProvider | undefined;
  readonly onClose?: () => void;
}) {
  const t = useUiTranslation();
  const codex = driver === "codex";
  const label = codex ? CODEX_BYOK_LABEL : CLAUDE_BYOK_LABEL;
  const variable = codex ? withCodexByokVariable : withClaudeByokVariable;
  const environmentId = environment.environmentId;
  const [expanded, setExpanded] = useState(!instance);
  const [draft, setDraft] = useState(instance?.environment ?? []);
  const [name, setName] = useState(instance?.displayName ?? label);
  const config =
    typeof instance?.config === "object" && instance.config !== null ? instance.config : {};
  const models = readCustomModelEntries("customModels" in config ? config.customModels : []);
  const [modelIds, setModelIds] = useState(models.map((model) => model.slug).join(", "));
  const [enabled, setEnabled] = useState(instance?.enabled ?? true);
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState<{ fingerprint: string; message: string } | null>(null);
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, { reportFailure: false });
  const validate = useAtomCommand(serverEnvironment.validateProviderEndpoint, {
    reportFailure: false,
  });
  const canSave = useAtomValue(
    serverEnvironment.mutateProviderInstance.permissionAtom(environmentId),
  );
  const canCheck = useAtomValue(
    serverEnvironment.validateProviderEndpoint.permissionAtom(environmentId, {
      instanceId,
      check: "connection",
    }),
  );
  const canTest = useAtomValue(
    serverEnvironment.validateProviderEndpoint.permissionAtom(environmentId, {
      instanceId,
      check: "model",
    }),
  );
  const protocol = readClaudeByokProtocol(draft);
  const mode = readClaudeByokAuthMode(draft);
  const credentialName = codex ? "T3_CODEX_API_KEY" : claudeByokAuthVariable(mode);
  const baseName = codex ? "T3_CODEX_BASE_URL" : "ANTHROPIC_BASE_URL";
  const credential = draft.find((entry) => entry.name === credentialName);
  const urlValue = draft.find((entry) => entry.name === baseName)?.value;
  const url = typeof urlValue === "string" ? urlValue : "";
  const ids = [
    ...new Set(
      modelIds
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  const fingerprint = JSON.stringify(instance);
  const dirty =
    !instance ||
    name !== (instance.displayName ?? label) ||
    enabled !== (instance.enabled ?? true) ||
    JSON.stringify(draft) !== JSON.stringify(instance.environment ?? []) ||
    ids.join(",") !== models.map((model) => model.slug).join(",");
  const valid =
    !(codex ? codexByokUrlError(url.trim()) : claudeByokUrlError(url.trim())) &&
    ids.length > 0 &&
    !!credential &&
    (credential.valueRedacted ||
      typeof credential.value !== "string" ||
      credential.value.length > 0);
  const policy = environment.serverConfig.managedPolicy;
  const locked =
    policy?.lockedSettings.some(
      (path) => path === "providerInstances" || path.startsWith(`providerInstances.${instanceId}`),
    ) ?? false;
  const disabled = pending || !canSave || locked;
  const field = (
    label: string,
    value: string,
    onChange: (text: string) => void,
    secret = false,
  ) => (
    <View className="gap-1">
      <Text className="text-sm text-foreground-muted">{t(label)}</Text>
      <TextInput
        accessibilityLabel={t(label)}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholderTextColorClassName="accent-foreground-muted"
        placeholder={t(secret && credential?.valueRedacted ? "Stored credential" : label)}
        value={value}
        onChangeText={(text) => {
          onChange(text);
          setFeedback(null);
        }}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!disabled}
      />
    </View>
  );
  const check = async (kind: "connection" | "model", model?: string) => {
    setChecking(true);
    setPending(true);
    const result = await validate({
      environmentId,
      input: { instanceId, check: kind, ...(model ? { model } : {}) },
    });
    setPending(false);
    setChecking(false);
    const failure = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
    setFeedback({
      fingerprint,
      message:
        (model ? `${model}: ` : "") +
        (result._tag === "Success"
          ? result.value.message
          : failure instanceof Error
            ? failure.message
            : t("Check failed.")),
    });
  };
  return (
    <View className="border-b border-border-subtle">
      {instance ? (
        <ListRow
          label={instance.displayName ?? label}
          description={instance.enabled === false ? t("Turned off") : label}
          detail={t(expanded ? "Done" : "Edit")}
          disabled={pending}
          onPress={() => setExpanded(!expanded)}
        />
      ) : null}
      {expanded ? (
        <>
          {provider ? (
            <ClaudeInstallationControls
              environment={environment}
              provider={provider}
              connectionDisabled={dirty || pending}
            />
          ) : null}
          <View className="gap-3 p-4">
            {provider && dirty ? (
              <Text textRole="footnote" className="text-foreground-muted">
                {t("Save or revert your changes before switching connections.")}
              </Text>
            ) : null}
            {field("Display name", name, setName)}
            {!codex ? (
              <Menu
                actions={[
                  {
                    id: "anthropic",
                    title: "Anthropic Messages",
                    state: protocol === "anthropic" ? "on" : "off",
                  },
                  {
                    id: "openai",
                    title: "OpenAI Chat Completions",
                    state: protocol === "openai" ? "on" : "off",
                  },
                ]}
                onPressAction={(event) => {
                  const value = event.nativeEvent.event;
                  if (!disabled && (value === "anthropic" || value === "openai")) {
                    setDraft(withClaudeByokVariable(draft, CLAUDE_BYOK_PROTOCOL_VARIABLE, value));
                    setFeedback(null);
                  }
                }}
              >
                <ControlPill
                  label={protocol === "openai" ? "OpenAI Chat Completions" : "Anthropic Messages"}
                  variant="pill"
                  disabled={disabled}
                />
              </Menu>
            ) : null}
            {field("API base URL", url, (value) => setDraft(variable(draft, baseName, value)))}
            {!codex ? (
              <Menu
                actions={[
                  { id: "bearer", title: "Bearer Token", state: mode === "bearer" ? "on" : "off" },
                  {
                    id: "apiKey",
                    title: protocol === "openai" ? "API Key (Bearer)" : "API Key (x-api-key)",
                    state: mode === "apiKey" ? "on" : "off",
                  },
                ]}
                onPressAction={(event) => {
                  const value = event.nativeEvent.event;
                  if (!disabled && (value === "bearer" || value === "apiKey")) {
                    setDraft(withClaudeByokVariable(draft, claudeByokAuthVariable(value), ""));
                    setFeedback(null);
                  }
                }}
              >
                <ControlPill
                  label={
                    mode === "bearer"
                      ? "Bearer Token"
                      : protocol === "openai"
                        ? "API Key (Bearer)"
                        : "API Key (x-api-key)"
                  }
                  variant="pill"
                  disabled={disabled}
                />
              </Menu>
            ) : null}
            {field(
              codex ? "API Key" : "BA credential",
              typeof credential?.value === "string" ? credential.value : "",
              (value) => setDraft(variable(draft, credentialName, value)),
              true,
            )}
            {field("Model IDs", modelIds, setModelIds)}
            {instance ? (
              <View className="gap-2">
                <Text textRole="footnote" className="text-foreground-muted">
                  {t("Test this model and its tools. Sends two requests and uses API credits.")}
                </Text>
                {models.map((model) => (
                  <View
                    key={model.slug}
                    className="flex-row flex-wrap items-center justify-between gap-2"
                  >
                    <Text className="shrink text-foreground">{model.name}</Text>
                    <ControlPill
                      label={t("Test model & tools")}
                      accessibilityLabel={t("{action}: {model}", {
                        action: t("Test model & tools"),
                        model: model.slug,
                      })}
                      variant="pill"
                      disabled={disabled || dirty || !enabled || !valid || !canTest}
                      onPress={() => void check("model", model.slug)}
                    />
                  </View>
                ))}
              </View>
            ) : null}
            <View className="-mx-4">
              <ListToggleRow
                label={t("BYOK enabled")}
                value={enabled}
                disabled={disabled}
                onValueChange={(value) => {
                  setEnabled(value);
                  setFeedback(null);
                }}
              />
            </View>
            {dirty && !valid ? (
              <Text className="text-sm text-foreground-muted">
                {t("Enter a base URL, credential, and at least one model ID.")}
              </Text>
            ) : null}
            <View className="flex-row flex-wrap gap-2">
              <ControlPill
                label={t("Save")}
                variant="primary"
                disabled={disabled || !dirty || !valid}
                onPress={() => {
                  void (async () => {
                    setPending(true);
                    const result = await mutate({
                      environmentId,
                      input: {
                        patch: {},
                        providerInstanceMutation: {
                          operation: instance ? "upsert" : "create",
                          instanceId,
                          instance: {
                            ...instance,
                            driver: ProviderDriverKind.make(driver),
                            displayName: name,
                            enabled,
                            config: {
                              ...config,
                              ...(codex
                                ? {
                                    connectionMode: "byok",
                                    setupMode: "existing",
                                    runtimeSource: codexRuntimeSource(
                                      instance?.config ?? { runtimeSource: "managed" },
                                    ),
                                  }
                                : {
                                    customModelsOnly: true,
                                    ...(!instance
                                      ? { homePath: `~/.claude-t3/${instanceId}` }
                                      : {}),
                                  }),
                              customModels: ids.map((slug) =>
                                toCustomModelSetting(
                                  models.find((model) => model.slug === slug) ?? {
                                    slug,
                                    name: slug,
                                    capabilities: null,
                                  },
                                ),
                              ),
                            },
                            environment: draft,
                          },
                        },
                      },
                    });
                    setPending(false);
                    if (result._tag === "Success") {
                      const saved = result.value.providerInstances[instanceId];
                      if (saved) {
                        setDraft(saved.environment ?? []);
                        setFeedback(null);
                      }
                      onClose?.();
                    } else {
                      const failure = squashAtomCommandFailure(result);
                      setFeedback({
                        fingerprint,
                        message: failure instanceof Error ? failure.message : t("Save failed."),
                      });
                    }
                  })();
                }}
              />
              <ControlPill
                label={t("Revert")}
                variant="pill"
                disabled={disabled || !dirty}
                onPress={() => {
                  if (!instance) {
                    onClose?.();
                    return;
                  }
                  setDraft(instance.environment ?? []);
                  setName(instance.displayName ?? label);
                  setEnabled(instance.enabled ?? true);
                  setModelIds(models.map((model) => model.slug).join(", "));
                  setFeedback(null);
                }}
              />
              <ControlPill
                label={t("Check connection")}
                variant="pill"
                disabled={disabled || dirty || !enabled || !canCheck}
                onPress={() => void check("connection")}
              />
              {checking ? (
                <ControlPill
                  label={t("Cancel check")}
                  variant="pill"
                  onPress={() =>
                    void validate({ environmentId, input: { instanceId, check: "cancel" } })
                  }
                />
              ) : null}
            </View>
            {feedback && feedback.fingerprint === fingerprint ? (
              <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
                {t(feedback.message)}
              </Text>
            ) : null}
          </View>
        </>
      ) : null}
    </View>
  );
}

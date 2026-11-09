import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { Switch, TextInput, View } from "react-native";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
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
import { Menu } from "../../components/ui/Menu";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiTranslation } from "../../lib/useUiTranslation";
import type { SettingsTarget } from "./settings-environment-filter";

export function ClaudeByokProviderSettings({
  environment,
}: {
  readonly environment: SettingsTarget;
}) {
  const t = useUiTranslation();
  const [adding, setAdding] = useState(false);
  const instances = Object.entries(environment.serverConfig.settings.providerInstances).filter(
    ([, instance]) => instance.driver === "claudeAgent" && isClaudeByok(instance.config),
  );
  const existing = new Set(Object.keys(environment.serverConfig.settings.providerInstances));
  let id = "claude_byok";
  for (let suffix = 2; existing.has(id); suffix++) id = `claude_byok_${suffix}`;
  return (
    <View className="gap-3 p-4">
      {instances.map(([instanceId, instance]) => (
        <ClaudeByokEditor
          key={`${instanceId}:${JSON.stringify(instance.environment)}`}
          environment={environment}
          instanceId={ProviderInstanceId.make(instanceId)}
          instance={instance}
        />
      ))}
      {adding ? (
        <ClaudeByokEditor
          environment={environment}
          instanceId={ProviderInstanceId.make(id)}
          onClose={() => setAdding(false)}
        />
      ) : (
        <ControlPill
          label={t("Add {name}", { name: CLAUDE_BYOK_LABEL })}
          variant="pill"
          onPress={() => setAdding(true)}
        />
      )}
    </View>
  );
}

function ClaudeByokEditor({
  environment,
  instanceId,
  instance,
  onClose,
}: {
  readonly environment: SettingsTarget;
  readonly instanceId: ProviderInstanceId;
  readonly instance?: ProviderInstanceConfig;
  readonly onClose?: () => void;
}) {
  const t = useUiTranslation();
  const environmentId = environment.environmentId;
  const [expanded, setExpanded] = useState(!instance);
  const [draft, setDraft] = useState(instance?.environment ?? []);
  const [name, setName] = useState(instance?.displayName ?? CLAUDE_BYOK_LABEL);
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
  const credentialName = claudeByokAuthVariable(mode);
  const credential = draft.find((entry) => entry.name === credentialName);
  const urlValue = draft.find((entry) => entry.name === "ANTHROPIC_BASE_URL")?.value;
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
    name !== instance.displayName ||
    enabled !== instance.enabled ||
    JSON.stringify(draft) !== JSON.stringify(instance.environment ?? []) ||
    ids.join(",") !== models.map((model) => model.slug).join(",");
  const valid =
    !claudeByokUrlError(url.trim()) &&
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
  const check = async (kind: "connection" | "model") => {
    setChecking(true);
    setPending(true);
    const result = await validate({
      environmentId,
      input: { instanceId, check: kind, ...(kind === "model" ? { model: ids[0] } : {}) },
    });
    setPending(false);
    setChecking(false);
    const failure = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
    setFeedback({
      fingerprint,
      message:
        result._tag === "Success"
          ? result.value.message
          : failure instanceof Error
            ? failure.message
            : t("Check failed."),
    });
  };
  return (
    <View className="gap-3">
      {instance ? (
        <ControlPill
          label={instance.displayName ?? CLAUDE_BYOK_LABEL}
          variant="pill"
          onPress={() => setExpanded(!expanded)}
        />
      ) : null}
      {expanded ? (
        <>
          {field("Display name", name, setName)}
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
          {field("BA base URL", url, (value) =>
            setDraft(withClaudeByokVariable(draft, "ANTHROPIC_BASE_URL", value)),
          )}
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
          {field(
            "BA credential",
            typeof credential?.value === "string" ? credential.value : "",
            (value) => setDraft(withClaudeByokVariable(draft, credentialName, value)),
            true,
          )}
          {field("Model IDs", modelIds, setModelIds)}
          <View className="flex-row items-center justify-between">
            <Text className="text-foreground">{t("Enabled")}</Text>
            <Switch
              accessibilityLabel={t("BYOK enabled")}
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
                          driver: ProviderDriverKind.make("claudeAgent"),
                          displayName: name,
                          enabled,
                          config: {
                            ...config,
                            customModelsOnly: true,
                            ...(!instance ? { homePath: `~/.claude-t3/${instanceId}` } : {}),
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
                setName(instance.displayName ?? CLAUDE_BYOK_LABEL);
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
            <ControlPill
              label={t("Test model & tools")}
              accessibilityLabel={t("Test first model and tools, uses API credits")}
              variant="pill"
              disabled={disabled || dirty || !enabled || !valid || !canTest}
              onPress={() => void check("model")}
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
        </>
      ) : null}
    </View>
  );
}

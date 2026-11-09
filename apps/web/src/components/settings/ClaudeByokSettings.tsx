import { useUiTranslation } from "~/hooks/useUiTranslation";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { CheckIcon, FlaskConicalIcon, PlugIcon, SaveIcon, Undo2Icon, XIcon } from "lucide-react";
import type {
  EnvironmentId,
  ProviderInstanceConfig,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  CLAUDE_BYOK_PROTOCOL_VARIABLE,
  readClaudeByokProtocol,
  claudeByokAuthVariable,
  claudeByokUrlError,
  readClaudeByokAuthMode,
  withClaudeByokVariable,
} from "@t3tools/shared/claudeByok";
import { readCustomModelEntries } from "@t3tools/shared/model";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { SecretSourceInput, type SecretSource } from "./SecretSourceInput";

export const CLAUDE_BYOK_ENVIRONMENT_NAMES = new Set([
  CLAUDE_BYOK_PROTOCOL_VARIABLE,
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
]);

export function claudeByokFormError(environment: ProviderInstanceEnvironment): string | null {
  const url = environment.find((entry) => entry.name === "ANTHROPIC_BASE_URL")?.value;
  const error = claudeByokUrlError(typeof url === "string" ? url.trim() : "");
  if (error) return error;
  const credentials = environment.filter(
    (entry) =>
      (entry.name === "ANTHROPIC_AUTH_TOKEN" || entry.name === "ANTHROPIC_API_KEY") &&
      (entry.valueRedacted || typeof entry.value !== "string" || entry.value.trim().length > 0),
  );
  return credentials.length === 1 ? null : "Configure exactly one Bearer Token or API Key.";
}

export function ClaudeByokFields({
  environment,
  onChange,
  secretSources,
  disabled = false,
}: {
  readonly environment: ProviderInstanceEnvironment;
  readonly onChange: (environment: ProviderInstanceEnvironment) => void;
  readonly secretSources: ReadonlyArray<SecretSource>;
  readonly disabled?: boolean;
}) {
  const t = useUiTranslation();
  const protocol = readClaudeByokProtocol(environment);
  const mode = readClaudeByokAuthMode(environment);
  const credentialName = claudeByokAuthVariable(mode);
  const credential = environment.find((entry) => entry.name === credentialName);
  const baseUrl = environment.find((entry) => entry.name === "ANTHROPIC_BASE_URL")?.value;
  const url = typeof baseUrl === "string" ? baseUrl : "";
  const error = url.length > 0 ? claudeByokUrlError(url.trim()) : null;
  return (
    <>
      <SettingsRow
        title={t("Protocol")}
        control={
          <Select
            value={protocol}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === "anthropic" || value === "openai")
                onChange(withClaudeByokVariable(environment, CLAUDE_BYOK_PROTOCOL_VARIABLE, value));
            }}
          >
            <SelectTrigger size="sm" aria-label={t("Protocol")}>
              <SelectValue>
                {t(protocol === "openai" ? "OpenAI Chat Completions" : "Anthropic Messages")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="anthropic">{t("Anthropic Messages")}</SelectItem>
              <SelectItem value="openai">{t("OpenAI Chat Completions")}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title={t("BA base URL")}
        status={
          error ? (
            <span role="alert" className="text-destructive">
              {t(error)}
            </span>
          ) : undefined
        }
        control={
          <Input
            aria-label={t("BA base URL")}
            size="sm"
            value={url}
            disabled={disabled}
            placeholder="https://ba.example.com"
            aria-invalid={error !== null}
            onChange={(event) =>
              onChange(
                withClaudeByokVariable(environment, "ANTHROPIC_BASE_URL", event.target.value),
              )
            }
          />
        }
      />
      <SettingsRow
        title={t("Authentication")}
        control={
          <Select
            value={mode}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === "bearer" || value === "apiKey")
                onChange(withClaudeByokVariable(environment, claudeByokAuthVariable(value), ""));
            }}
          >
            <SelectTrigger size="sm" aria-label={t("BA authentication")}>
              <SelectValue>
                {mode === "bearer"
                  ? t("Bearer Token")
                  : t(protocol === "openai" ? "API Key (Bearer)" : "API Key (x-api-key)")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="bearer">{t("Bearer Token")}</SelectItem>
              <SelectItem value="apiKey">
                {t(protocol === "openai" ? "API Key (Bearer)" : "API Key (x-api-key)")}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title={mode === "bearer" ? t("Bearer Token") : t("API Key")}
        control={
          <SecretSourceInput
            key={credentialName}
            aria-label={t("BA credential")}
            size="sm"
            sources={secretSources}
            disabled={disabled}
            configured={credential?.valueRedacted === true}
            value={credential?.value ?? ""}
            onChange={(event) =>
              onChange(withClaudeByokVariable(environment, credentialName, event.target.value))
            }
            onSecretChange={(secret) =>
              onChange(withClaudeByokVariable(environment, credentialName, secret ?? ""))
            }
          />
        }
      />
    </>
  );
}

export function ClaudeByokSettings({
  instance,
  instanceId,
  environmentId,
  readOnly,
  secretSources,
}: {
  readonly instance: ProviderInstanceConfig;
  readonly instanceId: ProviderInstanceId;
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
  readonly secretSources: ReadonlyArray<SecretSource>;
}) {
  const t = useUiTranslation();
  const [draft, setDraft] = useState(instance.environment ?? []);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const busy = running || saving;
  const [feedback, setFeedback] = useState<{
    fingerprint: string;
    message: string;
    success: boolean;
  } | null>(null);
  const models = readCustomModelEntries(
    typeof instance.config === "object" &&
      instance.config !== null &&
      "customModels" in instance.config
      ? instance.config.customModels
      : [],
  );
  const [testModel, setTestModel] = useState(models[0]?.slug ?? "");
  const fingerprint = JSON.stringify([instance.config, instance.environment]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(instance.environment ?? []);
  const error = claudeByokFormError(draft);
  const runCheck = useAtomCommand(serverEnvironment.validateProviderEndpoint, {
    reportFailure: false,
  });
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
  });
  const canCheckConnection = useAtomValue(
    serverEnvironment.validateProviderEndpoint.permissionAtom(environmentId, {
      instanceId,
      check: "connection",
    }),
  );
  const canCheckModel = useAtomValue(
    serverEnvironment.validateProviderEndpoint.permissionAtom(environmentId, {
      instanceId,
      check: "model",
    }),
  );
  const check = async (kind: "connection" | "model") => {
    setRunning(true);
    setFeedback(null);
    const result = await runCheck({
      environmentId,
      input: { instanceId, check: kind, ...(kind === "model" ? { model: testModel } : {}) },
    });
    setRunning(false);
    const failure = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
    setFeedback({
      fingerprint,
      success: result._tag === "Success",
      message:
        result._tag === "Success"
          ? result.value.message
          : failure instanceof Error
            ? failure.message
            : "Check failed. Try again.",
    });
  };
  const unavailable = readOnly || dirty || error !== null || !instance.enabled;
  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setFeedback(null);
    const result = await mutate({
      environmentId,
      input: {
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId,
          instance: {
            ...instance,
            environment: draft.map((entry) =>
              entry.name === "ANTHROPIC_BASE_URL" && typeof entry.value === "string"
                ? { ...entry, value: entry.value.trim() }
                : entry,
            ),
          },
        },
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setDraft(result.value.providerInstances[instanceId]?.environment ?? []);
    } else {
      const failure = squashAtomCommandFailure(result);
      setSaveError(failure instanceof Error ? failure.message : "Save failed. Try again.");
    }
  };
  return (
    <>
      <ClaudeByokFields
        environment={draft}
        onChange={(next) => {
          setDraft(next);
          setFeedback(null);
          setSaveError(null);
        }}
        secretSources={secretSources}
        disabled={readOnly || busy}
      />
      <SettingsRow
        title={t("Connection settings")}
        status={
          saveError ? (
            <span role="alert" className="text-destructive">
              {t(saveError)}
            </span>
          ) : dirty ? (
            t(error ?? "Unsaved changes")
          ) : undefined
        }
        control={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!dirty || readOnly || busy}
              onClick={() => {
                setDraft(instance.environment ?? []);
                setFeedback(null);
                setSaveError(null);
              }}
            >
              <Undo2Icon />
              {t("Revert")}
            </Button>
            <Button
              size="sm"
              disabled={!dirty || error !== null || readOnly || busy}
              onClick={() => void save()}
            >
              <SaveIcon />
              {saving ? t("Saving...") : t("Save")}
            </Button>
          </div>
        }
      />
      <SettingsRow
        title={t("Connection check")}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={unavailable || busy || !canCheckConnection}
            onClick={() => void check("connection")}
          >
            <PlugIcon />
            {t("Check connection")}
          </Button>
        }
      />
      <SettingsRow
        title={t("Model & tools")}
        control={
          <div className="flex w-full min-w-0 flex-wrap gap-2">
            <div className="min-w-0 flex-1">
              <Select
                value={models.some((model) => model.slug === testModel) ? testModel : null}
                disabled={busy || readOnly}
                onValueChange={(value) => {
                  setTestModel(value ?? "");
                  setFeedback(null);
                }}
              >
                <SelectTrigger size="sm" aria-label={t("BYOK test model")}>
                  <SelectValue placeholder={t("Select model")} />
                </SelectTrigger>
                <SelectPopup>
                  {models.map((model) => (
                    <SelectItem key={model.slug} value={model.slug}>
                      {model.name ?? model.slug}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={
                unavailable ||
                busy ||
                !canCheckModel ||
                !models.some((model) => model.slug === testModel)
              }
              title={t("Sends two model requests and uses API credits")}
              onClick={() => void check("model")}
            >
              <FlaskConicalIcon />
              {t("Test model & tools")}
            </Button>
          </div>
        }
      />
      {running ? (
        <SettingsRow
          title={t("Checking...")}
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void runCheck({ environmentId, input: { instanceId, check: "cancel" } })
              }
            >
              <XIcon />
              {t("Cancel")}
            </Button>
          }
        />
      ) : null}
      {!dirty && feedback?.fingerprint === fingerprint ? (
        <SettingsRow
          title={
            feedback.success ? (
              <span className="flex items-center gap-2">
                <CheckIcon className="size-4" />
                {t("Check complete")}
              </span>
            ) : (
              t("Check failed")
            )
          }
          status={
            <span role="status" className={feedback.success ? undefined : "text-destructive"}>
              {t(feedback.message)}
            </span>
          }
        />
      ) : null}
    </>
  );
}

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
      entry.name !== "ANTHROPIC_BASE_URL" &&
      CLAUDE_BYOK_ENVIRONMENT_NAMES.has(entry.name) &&
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
  const mode = readClaudeByokAuthMode(environment);
  const credentialName = claudeByokAuthVariable(mode);
  const credential = environment.find((entry) => entry.name === credentialName);
  const baseUrl = environment.find((entry) => entry.name === "ANTHROPIC_BASE_URL")?.value;
  const url = typeof baseUrl === "string" ? baseUrl : "";
  const error = url.length > 0 ? claudeByokUrlError(url.trim()) : null;
  return (
    <>
      <SettingsRow
        title="Protocol"
        control={<span className="text-sm text-muted-foreground">Anthropic Messages</span>}
      />
      <SettingsRow
        title="BA base URL"
        status={
          error ? (
            <span role="alert" className="text-destructive">
              {error}
            </span>
          ) : undefined
        }
        control={
          <Input
            aria-label="BA base URL"
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
        title="Authentication"
        control={
          <Select
            value={mode}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === "bearer" || value === "apiKey")
                onChange(withClaudeByokVariable(environment, claudeByokAuthVariable(value), ""));
            }}
          >
            <SelectTrigger size="sm" aria-label="BA authentication">
              <SelectValue>
                {mode === "bearer" ? "Bearer Token" : "API Key (x-api-key)"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="bearer">Bearer Token</SelectItem>
              <SelectItem value="apiKey">API Key (x-api-key)</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title={mode === "bearer" ? "Bearer Token" : "API Key"}
        control={
          <SecretSourceInput
            key={credentialName}
            aria-label="BA credential"
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
  onUpdate,
  readOnly,
  secretSources,
}: {
  readonly instance: ProviderInstanceConfig;
  readonly instanceId: ProviderInstanceId;
  readonly environmentId: EnvironmentId;
  readonly onUpdate: (instance: ProviderInstanceConfig) => void;
  readonly readOnly: boolean;
  readonly secretSources: ReadonlyArray<SecretSource>;
}) {
  const [draft, setDraft] = useState(instance.environment ?? []);
  const [running, setRunning] = useState(false);
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
  return (
    <>
      <ClaudeByokFields
        environment={draft}
        onChange={(next) => {
          setDraft(next);
          setFeedback(null);
        }}
        secretSources={secretSources}
        disabled={readOnly || running}
      />
      <SettingsRow
        title="Connection settings"
        status={dirty ? (error ?? "Unsaved changes") : undefined}
        control={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!dirty || readOnly || running}
              onClick={() => {
                setDraft(instance.environment ?? []);
                setFeedback(null);
              }}
            >
              <Undo2Icon />
              Revert
            </Button>
            <Button
              size="sm"
              disabled={!dirty || error !== null || readOnly || running}
              onClick={() =>
                onUpdate({
                  ...instance,
                  environment: draft.map((entry) =>
                    entry.name === "ANTHROPIC_BASE_URL" && typeof entry.value === "string"
                      ? { ...entry, value: entry.value.trim() }
                      : entry,
                  ),
                })
              }
            >
              <SaveIcon />
              Save
            </Button>
          </div>
        }
      />
      <SettingsRow
        title="Connection check"
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={unavailable || running || !canCheckConnection}
            onClick={() => void check("connection")}
          >
            <PlugIcon />
            Check connection
          </Button>
        }
      />
      <SettingsRow
        title="Model & tools"
        control={
          <div className="flex w-full min-w-0 flex-wrap gap-2">
            <div className="min-w-0 flex-1">
              <Select
                value={models.some((model) => model.slug === testModel) ? testModel : null}
                disabled={running || readOnly}
                onValueChange={(value) => {
                  setTestModel(value ?? "");
                  setFeedback(null);
                }}
              >
                <SelectTrigger size="sm" aria-label="BYOK test model">
                  <SelectValue placeholder="Select model" />
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
                running ||
                !canCheckModel ||
                !models.some((model) => model.slug === testModel)
              }
              title="Sends two model requests and uses API credits"
              onClick={() => void check("model")}
            >
              <FlaskConicalIcon />
              Test model & tools
            </Button>
          </div>
        }
      />
      {running ? (
        <SettingsRow
          title="Checking..."
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void runCheck({ environmentId, input: { instanceId, check: "cancel" } })
              }
            >
              <XIcon />
              Cancel
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
                Check complete
              </span>
            ) : (
              "Check failed"
            )
          }
          status={
            <span role="status" className={feedback.success ? undefined : "text-destructive"}>
              {feedback.message}
            </span>
          }
        />
      ) : null}
    </>
  );
}

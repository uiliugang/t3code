import { useState } from "react";
import type { ProviderConnectionMode } from "@t3tools/contracts";
import { isClaudeByok } from "@t3tools/shared/claudeByok";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ProviderConnectionHelp } from "./ProviderConnectionHelp";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { codexConnectionMode, codexRuntimeSource } from "@t3tools/shared/codexByok";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function CodexConnectionSettings({
  environmentId,
  instanceId,
  config,
  disabled,
  onChange,
  codex = true,
}: {
  readonly codex?: boolean;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly config: unknown;
  readonly disabled: boolean;
  readonly onChange: (config: Record<string, unknown>) => void;
}) {
  const t = useUiTranslation();
  const capabilities = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment
    .capabilities;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, { reportFailure: false });
  const mode = codex ? codexConnectionMode(config) : isClaudeByok(config) ? "byok" : "existing";
  const changeConnection = async (value: ProviderConnectionMode) => {
    if (value === mode || pending) return;
    if (!capabilities?.providerConnectionProfiles) {
      onChange({
        ...current,
        connectionMode: value,
        runtimeSource: source,
        setupMode: value === "chatgpt" ? "managed" : "existing",
      });
      return;
    }
    setPending(true);
    setError(null);
    const result = await mutate({
      environmentId,
      input: {
        patch: {},
        providerInstanceMutation: {
          operation: "switch-connection",
          instanceId,
          connectionMode: value,
          expectedConnectionMode: mode,
        },
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error ? failure.message : t("Could not switch connection. Try again."),
      );
    }
  };
  if (!(capabilities?.providerConnectionProfiles || (codex && capabilities?.codexByok)))
    return null;
  const source = codexRuntimeSource(config);
  const current = config && typeof config === "object" ? config : {};
  return (
    <SettingsSection title={t("Connection")}>
      <SettingsRow
        title={
          <span className="inline-flex items-center gap-1">
            {t("Connection method")}
            {capabilities?.providerConnectionProfiles ? (
              <ProviderConnectionHelp codex={codex} />
            ) : null}
          </span>
        }
        description={t(
          capabilities?.providerConnectionProfiles
            ? "Each connection keeps its own configuration and credentials. Switching back restores what you saved."
            : "Changing the runtime keeps this login. Changing the connection uses its own credentials.",
        )}
        status={
          error ? (
            <span role="alert" className="text-destructive">
              {t(error)}
            </span>
          ) : pending ? (
            t("Switching connection...")
          ) : undefined
        }
        control={
          <Select
            value={mode}
            disabled={disabled || pending}
            onValueChange={(value) => {
              if (value === "chatgpt" || value === "existing" || value === "byok")
                void changeConnection(value);
            }}
          >
            <SelectTrigger size="sm" aria-label={t("Connection method")}>
              <SelectValue>
                {t(
                  mode === "chatgpt"
                    ? "ChatGPT account"
                    : mode === "byok"
                      ? "API Key"
                      : codex
                        ? "Use existing CLI"
                        : "Claude account / existing CLI",
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {codex ? <SelectItem value="chatgpt">{t("ChatGPT account")}</SelectItem> : null}
              <SelectItem value="existing">
                {t(codex ? "Use existing CLI" : "Claude account / existing CLI")}
              </SelectItem>
              <SelectItem value="byok">{t("API Key")}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {codex ? (
        <SettingsRow
          title={t("Runtime source")}
          description={t(
            "Managed installations are shared by providers on this environment. Credentials stay separate.",
          )}
          control={
            <Select
              value={source}
              disabled={disabled || pending}
              onValueChange={(value) => {
                if (value === "auto" || value === "managed" || value === "local")
                  onChange({
                    ...current,
                    connectionMode: mode,
                    runtimeSource: value,
                    setupMode: mode === "chatgpt" ? "managed" : "existing",
                  });
              }}
            >
              <SelectTrigger size="sm" aria-label={t("Runtime source")}>
                <SelectValue>
                  {t(
                    source === "managed"
                      ? "Managed by T3"
                      : source === "local"
                        ? "Use local installation"
                        : "Automatic",
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="auto">{t("Automatic")}</SelectItem>
                <SelectItem value="managed">{t("Managed by T3")}</SelectItem>
                <SelectItem value="local">{t("Use local installation")}</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      {codex && source === "managed" ? (
        <ManagedInstall
          environmentId={environmentId}
          instanceId={instanceId}
          disabled={disabled || pending}
        />
      ) : null}
    </SettingsSection>
  );
}

function ManagedInstall({
  environmentId,
  instanceId,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly disabled: boolean;
}) {
  const t = useUiTranslation();
  const query = useEnvironmentQuery(
    serverEnvironment.providerInstallState({ environmentId, input: { instanceId } }),
  );
  const install = useAtomCommand(serverEnvironment.startProviderInstall);
  const canInstall = useAtomValue(
    serverEnvironment.startProviderInstall.permissionAtom(environmentId),
  );
  const state = query.data;
  const busy = state && ["downloading", "extracting", "verifying"].includes(state.phase);
  return (
    <SettingsRow
      title={t("Shared runtime")}
      status={state?.message ? <span role="status">{t(state.message)}</span> : undefined}
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !canInstall || !!busy}
          onClick={() => void install({ environmentId, input: { instanceId } })}
        >
          {t(busy ? "Installing..." : "Install / update")}
        </Button>
      }
    />
  );
}

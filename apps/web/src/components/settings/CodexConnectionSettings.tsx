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
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly config: unknown;
  readonly disabled: boolean;
  readonly onChange: (config: Record<string, unknown>) => void;
}) {
  const t = useUiTranslation();
  const supported = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment
    .capabilities?.codexByok;
  if (!supported) return null;
  const mode = codexConnectionMode(config);
  const source = codexRuntimeSource(config);
  const current = config && typeof config === "object" ? config : {};
  return (
    <SettingsSection title={t("Connection")}>
      <SettingsRow
        title={t("Connection method")}
        description={t(
          "Changing the runtime keeps this login. Changing the connection uses its own credentials.",
        )}
        control={
          <Select
            value={mode}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === "chatgpt" || value === "existing" || value === "byok")
                onChange({
                  ...current,
                  connectionMode: value,
                  runtimeSource: source,
                  setupMode: value === "chatgpt" ? "managed" : "existing",
                });
            }}
          >
            <SelectTrigger size="sm" aria-label={t("Connection method")}>
              <SelectValue>
                {t(
                  mode === "chatgpt"
                    ? "ChatGPT account"
                    : mode === "byok"
                      ? "API Key"
                      : "Use existing CLI",
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="chatgpt">{t("ChatGPT account")}</SelectItem>
              <SelectItem value="existing">{t("Use existing CLI")}</SelectItem>
              <SelectItem value="byok">{t("API Key")}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title={t("Runtime source")}
        description={t(
          "Managed installations are shared by providers on this environment. Credentials stay separate.",
        )}
        control={
          <Select
            value={source}
            disabled={disabled}
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
      {source === "managed" ? (
        <ManagedInstall environmentId={environmentId} instanceId={instanceId} disabled={disabled} />
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

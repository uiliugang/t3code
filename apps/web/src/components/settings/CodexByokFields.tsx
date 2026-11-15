import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import { codexByokUrlError, withCodexByokVariable } from "@t3tools/shared/codexByok";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";
import { SecretSourceInput, type SecretSource } from "./SecretSourceInput";

export function CodexByokFields({
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
  const base = environment.find((entry) => entry.name === "T3_CODEX_BASE_URL")?.value;
  const key = environment.find((entry) => entry.name === "T3_CODEX_API_KEY");
  const url = typeof base === "string" ? base : "";
  const error = url ? codexByokUrlError(url) : null;
  return (
    <>
      <SettingsRow
        title={t("API base URL")}
        description={t("Uses the Responses API. Include the API path, such as /v1.")}
        status={
          error ? (
            <span role="alert" className="text-destructive">
              {t(error)}
            </span>
          ) : undefined
        }
        control={
          <Input
            size="sm"
            aria-label={t("API base URL")}
            placeholder="https://api.openai.com/v1"
            value={url}
            disabled={disabled}
            aria-invalid={!!error}
            onChange={(event) =>
              onChange(withCodexByokVariable(environment, "T3_CODEX_BASE_URL", event.target.value))
            }
          />
        }
      />
      <SettingsRow
        title={t("API Key")}
        control={
          <SecretSourceInput
            size="sm"
            aria-label={t("API Key")}
            sources={secretSources}
            disabled={disabled}
            configured={key?.valueRedacted === true}
            value={key?.value ?? ""}
            onChange={(event) =>
              onChange(withCodexByokVariable(environment, "T3_CODEX_API_KEY", event.target.value))
            }
            onSecretChange={(secret) =>
              onChange(withCodexByokVariable(environment, "T3_CODEX_API_KEY", secret ?? ""))
            }
          />
        }
      />
    </>
  );
}

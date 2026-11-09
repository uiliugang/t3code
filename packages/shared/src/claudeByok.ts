import type {
  ClaudeSettings,
  ProviderInstanceEnvironment,
  ProviderInstanceEnvironmentVariable,
  ServerProvider,
} from "@t3tools/contracts";
import { readCustomModelEntries } from "./model.ts";

export const CLAUDE_BYOK_LABEL = "Claude \u00b7 BYOK";
export const CLAUDE_BYOK_PROTOCOL_VARIABLE = "T3_CLAUDE_API_FORMAT";
export const readClaudeByokProtocol = (environment: ProviderInstanceEnvironment) =>
  environment.find((entry) => entry.name === CLAUDE_BYOK_PROTOCOL_VARIABLE)?.value === "openai"
    ? "openai"
    : "anthropic";

export type ClaudeByokAuthMode = "bearer" | "apiKey";
export const claudeByokAuthVariable = (mode: ClaudeByokAuthMode) =>
  mode === "apiKey" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN";

export function isClaudeByok(config: unknown): boolean {
  return (
    typeof config === "object" &&
    config !== null &&
    "customModelsOnly" in config &&
    config.customModelsOnly === true
  );
}

export function readClaudeByokAuthMode(
  environment: ProviderInstanceEnvironment,
): ClaudeByokAuthMode {
  const credentials = environment.filter(
    (entry) => entry.name === "ANTHROPIC_AUTH_TOKEN" || entry.name === "ANTHROPIC_API_KEY",
  );
  const selected =
    credentials.find(
      (entry) => entry.valueRedacted || typeof entry.value !== "string" || entry.value.length > 0,
    ) ?? credentials[0];
  return selected?.name === "ANTHROPIC_API_KEY" ? "apiKey" : "bearer";
}

export function withClaudeByokVariable(
  environment: ProviderInstanceEnvironment,
  name: string,
  value: ProviderInstanceEnvironmentVariable["value"],
): ProviderInstanceEnvironment {
  const credential = name === "ANTHROPIC_API_KEY" || name === "ANTHROPIC_AUTH_TOKEN";
  return [
    ...environment.filter((entry) =>
      credential
        ? entry.name !== "ANTHROPIC_API_KEY" && entry.name !== "ANTHROPIC_AUTH_TOKEN"
        : entry.name !== name,
    ),
    { name, value, sensitive: credential },
    ...(credential
      ? [
          {
            name: name === "ANTHROPIC_API_KEY" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY",
            value: "",
            sensitive: true,
          },
        ]
      : []),
  ];
}

export function claudeByokUrlError(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter an Anthropic API base URL.";
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return "Use an HTTP or HTTPS base URL without credentials, query parameters, or a fragment.";
  if (/\/(messages|chat\/completions)\/?$/.test(url.pathname))
    return "Enter the base URL, without /v1/messages or /chat/completions.";
  return null;
}

export function normalizeClaudeByokBaseUrl(value: string): string {
  const url = new URL(value.trim());
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return url.toString().replace(/\/$/, "");
}

export function claudeByokModelError(
  settings: Pick<ClaudeSettings, "customModelsOnly" | "customModels">,
  model: string,
): string | null {
  return settings.customModelsOnly &&
    !readCustomModelEntries(settings.customModels).some((entry) => entry.slug === model)
    ? "This model is not configured for Claude BYOK. Select a configured model."
    : null;
}

export function claudeByokSelectionError(
  provider: Pick<ServerProvider, "customModelsOnly" | "models"> | null | undefined,
  model: string,
): string | null {
  return provider?.customModelsOnly && !provider.models.some((entry) => entry.slug === model)
    ? "Select a configured Claude BYOK model before sending."
    : null;
}

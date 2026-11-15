import type {
  ProviderInstanceEnvironment,
  ProviderInstanceEnvironmentVariable,
} from "@t3tools/contracts";
import { parseUrl } from "./url.ts";

export const CODEX_BYOK_LABEL = "Codex · BYOK";
export const CODEX_BYOK_ENVIRONMENT_NAMES = new Set(["T3_CODEX_BASE_URL", "T3_CODEX_API_KEY"]);
const field = (config: unknown, name: string): unknown =>
  typeof config === "object" && config !== null ? Reflect.get(config, name) : undefined;

export function codexConnectionMode(config: unknown): "chatgpt" | "existing" | "byok" {
  const mode = field(config, "connectionMode");
  return mode === "chatgpt" || mode === "existing" || mode === "byok"
    ? mode
    : field(config, "setupMode") === "managed"
      ? "chatgpt"
      : "existing";
}

export function codexRuntimeSource(config: unknown): "auto" | "managed" | "local" {
  const source = field(config, "runtimeSource");
  return source === "auto" || source === "managed" || source === "local"
    ? source
    : codexConnectionMode(config) === "chatgpt"
      ? "auto"
      : "local";
}

export function codexByokUrlError(value: string): string | null {
  const url = parseUrl(value.trim());
  if (!url) return "Enter an API base URL.";
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return "Use an HTTP or HTTPS base URL without credentials, query parameters, or a fragment.";
  if (/\/(responses|chat\/completions|models)\/?$/.test(url.pathname))
    return "Enter the API base URL, without /responses, /chat/completions or /models.";
  return null;
}

export function codexByokFormError(environment: ProviderInstanceEnvironment): string | null {
  const base = environment.find((entry) => entry.name === "T3_CODEX_BASE_URL")?.value;
  const error = codexByokUrlError(typeof base === "string" ? base : "");
  if (error) return error;
  const key = environment.find((entry) => entry.name === "T3_CODEX_API_KEY");
  return key && (key.valueRedacted || typeof key.value !== "string" || key.value.trim())
    ? null
    : "Enter an API key.";
}

export function withCodexByokVariable(
  environment: ProviderInstanceEnvironment,
  name: string,
  value: ProviderInstanceEnvironmentVariable["value"],
): ProviderInstanceEnvironment {
  return [
    ...environment.filter((entry) => entry.name !== name),
    { name, value, sensitive: name === "T3_CODEX_API_KEY" },
  ];
}

export function codexByokLaunchArgs(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const provider = `{name="T3 API",base_url=${JSON.stringify(base)},model_catalog_url=${JSON.stringify(base + "/models")},env_key="T3_CODEX_API_KEY",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`;
  return ['model_provider="t3_byok"', `model_providers.t3_byok=${provider}`]
    .map((value) => `-c ${JSON.stringify(value)}`)
    .join(" ");
}

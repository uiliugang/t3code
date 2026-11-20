import type { ServerProvider } from "@t3tools/contracts";

export function canManageProvider(provider: ServerProvider) {
  return Boolean(
    provider.setup?.canAuthenticate || (provider.driver === "acpRegistry" && provider.installed),
  );
}

export function needsProviderSummary(provider: ServerProvider) {
  return provider.driver !== "claudeAgent" && !canManageProvider(provider);
}

export function providerSummaryStatus(
  provider: ServerProvider,
  t: UiTranslator = translateUi.bind(null, "en"),
) {
  if (!provider.enabled) return t("Turned off");
  if (!provider.installed) return t("Not installed");
  if (provider.auth.status === "authenticated") return t("Signed in");
  if (provider.auth.status === "unauthenticated") return t("Not signed in");
  return t("Unknown");
}
import { translateUi, type UiTranslator } from "@t3tools/shared/uiLocale";

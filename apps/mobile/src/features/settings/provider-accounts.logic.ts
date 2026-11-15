import type { ServerProvider } from "@t3tools/contracts";

export function canManageProvider(provider: ServerProvider) {
  return Boolean(
    provider.setup?.canAuthenticate || (provider.driver === "acpRegistry" && provider.installed),
  );
}

export function needsProviderSummary(provider: ServerProvider) {
  return provider.driver !== "claudeAgent" && !canManageProvider(provider);
}

export function providerSummaryStatus(provider: ServerProvider) {
  if (!provider.enabled) return "Turned off";
  if (!provider.installed) return "Not installed";
  if (provider.auth.status === "authenticated") return "Signed in";
  if (provider.auth.status === "unauthenticated") return "Not signed in";
  return "Unknown";
}

import { remainingPercent } from "@t3tools/shared/usageLimits";

import type { ProviderInstanceEntry } from "../../providerInstances";

export function collectProviderWeeklyUsage(providers: ReadonlyArray<ProviderInstanceEntry>) {
  return providers
    .filter((provider) => provider.enabled)
    .map((provider) => {
      const limits = provider.snapshot.usageLimits;
      const weekly = limits?.unavailable
        ? []
        : (limits?.windows.filter((window) => window.kind === "weekly") ?? []);
      // Overall allowances take precedence over model-specific weekly windows.
      const window =
        weekly.find((window) => window.id === "seven_day" || window.id === "secondary") ??
        weekly.reduce<(typeof weekly)[number] | undefined>(
          (selected, window) =>
            selected === undefined || window.usedPercent > selected.usedPercent ? window : selected,
          undefined,
        );
      return {
        instanceId: provider.instanceId,
        displayName: provider.displayName,
        accentColor: provider.accentColor,
        remaining: window ? remainingPercent(window) : null,
      };
    });
}

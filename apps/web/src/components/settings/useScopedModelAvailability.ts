import {
  type ProviderInstanceId,
  textGeneratorForSelection,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { memoize } from "effect/Function";

import { useUiTranslation } from "../../hooks/useUiTranslation";
import { mergeEnvironmentSettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  getTextGenerationModelOptionsByInstance,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useSettingsScope } from "./SettingsScopeContext";

export function useScopedModelDisabledReason(
  settings: UnifiedSettings,
  entries: readonly ProviderInstanceEntry[],
  textGeneration = false,
) {
  const t = useUiTranslation();
  const gt = useGT();
  const { targets } = useSettingsScope();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const optionsForInstance = textGeneration
    ? getTextGenerationModelOptionsByInstance
    : getCustomModelOptionsByInstance;
  const catalogFor = memoize((candidate: (typeof targets)[number]) => {
    const providers = providersByEnvironment.get(candidate.environmentId);
    if (!providers) return null;
    const options = optionsForInstance(
      mergeEnvironmentSettings(candidate.settings, settings),
      providers,
    );
    return new Map(
      applyProviderInstanceSettings(
        deriveProviderInstanceEntries(providers),
        candidate.settings,
        candidate.projectId,
      ).map((entry) => [
        entry.instanceId,
        {
          entry,
          models: new Set(
            options
              .get(entry.instanceId)
              ?.filter((option) => !option.isUnavailable)
              .map((option) => option.slug),
          ),
        },
      ]),
    );
  });
  return (instanceId: ProviderInstanceId, model: string): string | null => {
    const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
    const shownGenerator = textGeneratorForSelection(settings, instanceId);
    for (const candidate of targets) {
      const environment = environments.find(
        (entry) => entry.environmentId === candidate.environmentId,
      );
      const unavailable = environment
        ? t(
            "This model is unavailable on {environment}. Select that environment to choose its model separately.",
            { environment: environment.label },
          )
        : gt(
            "This model is unavailable on a selected environment. Select that environment to choose its model separately.",
          );
      const generator = textGeneratorForSelection(candidate.settings, instanceId);
      if (shownGenerator !== undefined || generator !== undefined) {
        // Only the shown environment's model list is loaded; elsewhere it must reach the same API.
        if (
          !generator?.enabled ||
          generator.kind !== shownGenerator?.kind ||
          generator.baseUrl !== shownGenerator.baseUrl
        ) {
          return unavailable;
        }
        continue;
      }
      if (!environment?.serverConfig) continue;
      const catalog = catalogFor(candidate);
      if (!catalog) continue;
      const option = catalog.get(instanceId);
      if (
        !option?.entry.enabled ||
        !option.entry.isAvailable ||
        option.entry.driverKind !== sourceEntry?.driverKind ||
        !option.models.has(model)
      ) {
        return unavailable;
      }
    }
    return null;
  };
}

import { resolveEnvironmentMachineKind } from "@t3tools/contracts";

import type { AppBarMenu } from "../../../components/ui/AppBar.types";
import { ENVIRONMENT_MACHINE_SYMBOLS } from "../../../components/EnvironmentMachineSymbol";
import { useSettingsEnvironmentFilter } from "../settings-environment-filter";
import { useUiTranslation } from "../../../lib/useUiTranslation";
import type { UiTranslator } from "@t3tools/shared/uiLocale";

/** The settings scope filter, as an `AppBar` menu. */
export function useSettingsEnvironmentMenu(): AppBarMenu {
  const t = useUiTranslation();
  const {
    availableTargets,
    selectedIds,
    selectAll,
    toggleEnvironment,
    selectableProjectGroups,
    selectedProjectKey,
    selectProject,
  } = useSettingsEnvironmentFilter();
  return {
    title: t("Filter settings environments and projects"),
    icon:
      selectedIds === null && selectedProjectKey === null
        ? "line.3.horizontal.decrease"
        : "line.3.horizontal.decrease.circle.fill",
    items: [
      {
        id: "all",
        title: t("All connected environments"),
        selected: selectedIds === null,
        onPress: selectAll,
      },
      ...availableTargets.map((entry) => ({
        id: `environment:${entry.environmentId}`,
        title: t("Environment · {name}", { name: entry.label }),
        icon: ENVIRONMENT_MACHINE_SYMBOLS[resolveEnvironmentMachineKind(entry.serverConfig)],
        subtitle: entry.displayUrl ?? undefined,
        selected: selectedIds === null || selectedIds.has(entry.environmentId),
        onPress: () => toggleEnvironment(entry.environmentId),
      })),
      {
        id: "project:all",
        title: t("All projects"),
        selected: selectedProjectKey === null,
        onPress: () => selectProject(null),
      },
      ...selectableProjectGroups.map((group) => ({
        id: `project:${group.key}`,
        title: t("Project · {name}", { name: projectMenuLabel(group, t) }),
        selected: selectedProjectKey === group.key,
        onPress: () => selectProject(group.key),
      })),
    ],
  };
}

const projectMenuLabel = (
  group: { readonly label: string; readonly archived: boolean },
  t: UiTranslator,
) => (group.archived ? t("{name} · Archived", { name: group.label }) : group.label);

import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { Platform } from "react-native";

import type { AppBarMenu } from "../../../components/ui/AppBar.types";
import { ENVIRONMENT_MACHINE_SYMBOLS } from "../../../components/EnvironmentMachineSymbol";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { withNativeGlassHeaderItem } from "../../layout/native-glass-header-items";
import { useSettingsEnvironmentFilter } from "../settings-environment-filter";
import { useUiTranslation } from "../../../lib/useUiTranslation";
import type { UiTranslator } from "@t3tools/shared/uiLocale";

export function SettingsEnvironmentFilterHeader(props: {
  readonly trailingItems?: readonly NativeStackHeaderItem[];
}) {
  const t = useUiTranslation();
  const {
    availableTargets,
    selectedTargets,
    selectedIds,
    selectAll,
    toggleEnvironment,
    selectableProjectGroups,
    selectedProjectKey,
    selectProject,
  } = useSettingsEnvironmentFilter();
  if (Platform.OS !== "ios") return null;

  const filterIcon =
    selectedIds === null && selectedProjectKey === null
      ? "line.3.horizontal.decrease"
      : "line.3.horizontal.decrease.circle.fill";
  const filterVersion = JSON.stringify({
    language: t("Settings scope"),
    selection: selectedIds === null ? null : [...selectedIds].sort(),
    targets: availableTargets.map((entry) => [
      entry.environmentId,
      entry.label,
      entry.displayUrl,
      resolveEnvironmentMachineKind(entry.serverConfig),
    ]),
    project: selectedProjectKey,
    projects: selectableProjectGroups.map((group) => [group.key, group.label]),
    trailingItems: props.trailingItems,
  });

  return (
    <NativeStackScreenOptions
      optionsVersion={filterVersion}
      options={{
        unstable_headerRightItems: () => [
          withNativeGlassHeaderItem({
            accessibilityLabel: t("Filter settings environments and projects"),
            icon: { name: filterIcon, type: "sfSymbol" },
            label: "",
            type: "menu",
            menu: {
              title: t("Settings scope"),
              items: [
                {
                  type: "submenu",
                  label:
                    selectedIds === null
                      ? t("All environments")
                      : t(
                          selectedTargets.length === 1
                            ? "{count} environment"
                            : "{count} environments",
                          { count: selectedTargets.length },
                        ),
                  items: [
                    {
                      type: "action",
                      label: t("All connected environments"),
                      state: selectedIds === null ? "on" : undefined,
                      onPress: selectAll,
                    },
                    ...availableTargets.map((entry) => ({
                      type: "action" as const,
                      label: entry.label,
                      icon: {
                        type: "sfSymbol" as const,
                        name: ENVIRONMENT_MACHINE_SYMBOLS[
                          resolveEnvironmentMachineKind(entry.serverConfig)
                        ],
                      },
                      description: entry.displayUrl ?? undefined,
                      state:
                        selectedIds === null || selectedIds.has(entry.environmentId)
                          ? ("on" as const)
                          : undefined,
                      onPress: () => toggleEnvironment(entry.environmentId),
                    })),
                  ],
                },
                {
                  type: "submenu",
                  label:
                    selectableProjectGroups.find((group) => group.key === selectedProjectKey)
                      ?.label ??
                    t(selectedProjectKey === null ? "All projects" : "Unavailable project"),
                  items: [
                    {
                      type: "action",
                      label: t("All projects"),
                      state: selectedProjectKey === null ? "on" : undefined,
                      onPress: () => selectProject(null),
                    },
                    ...selectableProjectGroups.map((group) => ({
                      type: "action" as const,
                      label: projectMenuLabel(group, t),
                      state: selectedProjectKey === group.key ? ("on" as const) : undefined,
                      onPress: () => selectProject(group.key),
                    })),
                  ],
                },
              ],
            },
          }),
          ...(props.trailingItems ?? []),
        ],
      }}
    />
  );
}

/** Android's settings scope filter, as an `AppBar` menu. */
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
        ? "line.3.horizontal.decrease.circle"
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

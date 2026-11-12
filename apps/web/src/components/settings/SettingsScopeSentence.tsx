import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useLocation } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, InfoIcon, LayersIcon } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProjectLabel } from "../ProjectLabel";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { ProjectTypeFilterControl } from "./ProjectTypeFilterControl";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import {
  ALL_ENVIRONMENTS_VALUE,
  ALL_PROJECTS_VALUE,
  environmentAxisValue,
  projectAxisValue,
  projectScopeMenuGroups,
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabel,
  settingsScopeEnvironmentLabels,
  settingsScopeProjectMachines,
} from "./settingsScopeAxis";

export const SETTINGS_DEVICE_ONLY_PATHS: ReadonlySet<string> = new Set([
  "/settings/general",
  "/settings/appearance",
  "/settings/chat",
  "/settings/diffs",
  "/settings/snap-shot",
  "/settings/connections",
  // Access picks its environment on the page itself.
  "/settings/access",
  "/settings/about",
]);

interface SettingsScopeMenuProps {
  readonly value: SettingsScopeSearch;
  readonly groups: readonly SidebarProjectSnapshot[];
  readonly environments: readonly EnvironmentPresentation[];
  readonly singleEnvironment: boolean;
  readonly onChange: (next: SettingsScopeSearch) => void;
}

export function SettingsScopeSentence() {
  const t = useUiTranslation();
  const scope = useOptionalSettingsScope();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useEnvironments();
  if (scope === null || SETTINGS_DEVICE_ONLY_PATHS.has(pathname)) return null;
  const props: SettingsScopeMenuProps = {
    value: scope.search,
    singleEnvironment: scope.singleEnvironment,
    groups: scope.groups,
    environments,
    onChange: scope.selectScope,
  };
  if (pathname === "/settings/skills")
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>{t("Manage environment")}</span>
        <EnvironmentScopeMenu
          {...props}
          value={{ machine: props.value.machine }}
          onChange={(next) => scope.selectScope({ machine: next.machine })}
        />
      </div>
    );
  const projectSettingsHint = t(
    "Can't find a setting? Keep this project picked above and hop to any other settings page.",
  );
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-3 text-sm text-muted-foreground sm:px-4">
      <span className="flex min-w-0 max-w-full items-center gap-1.5">
        <span className="shrink-0">{t("Applying settings for")}</span>
        <ProjectScopeMenu {...props} />
        {pathname === "/settings/projects" &&
        (scope.scope.kind === "project" || scope.scope.kind === "checkout") ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button size="icon-xs" variant="ghost-muted" aria-label={projectSettingsHint} />
              }
            >
              <InfoIcon aria-hidden className="size-3.5 text-info" />
            </TooltipTrigger>
            <TooltipPopup side="bottom" align="start">
              {projectSettingsHint}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </span>
      <span className="flex min-w-0 max-w-full items-center gap-1.5">
        <span className="shrink-0">
          {t(scope.search.machine || scope.scope.kind === "checkout" ? "on" : "across")}
        </span>
        <EnvironmentScopeMenu {...props} />
      </span>
    </p>
  );
}

interface ScopeOption {
  value: string;
  label: string;
  displayLabel?: ReactNode;
  secondary?: string;
  icon?: ReactNode;
  offline?: boolean;
}

function ScopeOptionLabel({ option }: { option: ScopeOption }) {
  const t = useUiTranslation();
  return (
    <>
      {option.icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{option.displayLabel ?? option.label}</span>
        {option.secondary ? (
          <span className="block truncate text-xs text-muted-foreground">{option.secondary}</span>
        ) : null}
      </span>
      {option.offline ? (
        <span className="shrink-0 text-xs text-muted-foreground">{t("Offline")}</span>
      ) : null}
    </>
  );
}

function ScopeMenu({
  ariaLabel,
  icon,
  label,
  displayLabel,
  value,
  options,
  allOption,
  searchLabel,
  header,
  searchable = false,
  onChange,
}: {
  ariaLabel: string;
  icon: ReactNode;
  label: string;
  displayLabel?: ReactNode;
  value: string;
  options: ScopeOption[];
  allOption: ScopeOption | null;
  searchLabel: string;
  header?: ReactNode;
  searchable?: boolean;
  onChange: (next: string) => void;
}) {
  const t = useUiTranslation();
  const [query, setQuery] = useState("");
  const useSearch = searchable || options.length > 6;
  const Trigger = useSearch ? ComboboxTrigger : MenuTrigger;
  const trigger = (
    <Trigger
      aria-label={`${ariaLabel}: ${label}`}
      render={<Button variant="outline" size="sm" />}
      className="min-w-0 max-w-72 shrink"
    >
      {icon}
      <span className="min-w-0 truncate">{displayLabel ?? label}</span>
      <ChevronDownIcon
        aria-hidden
        strokeWidth={1.75}
        className="-me-0.5 size-3.5 shrink-0 text-muted-foreground opacity-70"
      />
    </Trigger>
  );
  const choices = allOption ? [allOption, ...options] : options;
  if (useSearch) {
    const needle = query.trim().toLowerCase();
    const filteredItems = choices.filter((option) =>
      `${option.label} ${option.secondary ?? ""} ${option.value}`.toLowerCase().includes(needle),
    );
    return (
      <Combobox
        items={choices}
        filteredItems={filteredItems}
        filter={null}
        autoHighlight
        itemToStringLabel={(option) => option.label}
        isItemEqualToValue={(a, b) => a.value === b.value}
        value={choices.find((option) => option.value === value) ?? null}
        onOpenChange={(open) => {
          if (!open) setQuery("");
        }}
        onValueChange={(option) => {
          if (option) onChange(option.value);
        }}
      >
        {trigger}
        <ComboboxPopup align="start" className="w-80">
          <ComboboxSearchInput
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {header ? <div className="px-2 py-2">{header}</div> : null}
          <ComboboxEmpty>{t("No matches found.")}</ComboboxEmpty>
          <ComboboxList>
            {(option: ScopeOption) => (
              <ComboboxItem key={option.value} value={option}>
                <ScopeOptionLabel option={option} />
                {option.value === value ? (
                  <CheckIcon aria-hidden className="size-3.5 shrink-0" />
                ) : null}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    );
  }
  return (
    <Menu>
      {trigger}
      <MenuPopup align="start">
        <div className="w-72 max-w-full">
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              if (typeof next === "string") onChange(next);
            }}
          >
            {choices.map((option, index) => (
              <Fragment key={option.value}>
                <MenuRadioItem value={option.value} closeOnClick>
                  <span className="flex min-w-0 items-center gap-2">
                    <ScopeOptionLabel option={option} />
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
                {index === 0 && allOption ? <MenuSeparator /> : null}
              </Fragment>
            ))}
          </MenuRadioGroup>
        </div>
      </MenuPopup>
    </Menu>
  );
}

export function EnvironmentScopeMenu({
  value,
  groups,
  environments,
  onChange,
  singleEnvironment,
}: SettingsScopeMenuProps) {
  const t = useUiTranslation();
  const resolved = resolveSettingsScope(value, groups, environments);
  const environmentValue = environmentAxisValue(
    value,
    resolved.kind === "checkout" ? resolved.environmentId : null,
  );
  const selected = environments.find(
    (environment) => environment.environmentId === environmentValue,
  );
  const project = groups.find((group) => group.projectKey === value.project);
  const memberEnvironmentIds = project
    ? new Set(project.memberProjects.map((member) => member.environmentId))
    : null;
  const options = memberEnvironmentIds
    ? environments.filter((environment) => memberEnvironmentIds.has(environment.environmentId))
    : environments;
  return (
    <ScopeMenu
      ariaLabel={t("Environment scope")}
      icon={
        selected ? (
          <EnvironmentMachineIcon
            aria-hidden
            kind={resolveEnvironmentMachineKind(selected.serverConfig)}
            className="size-3.5 shrink-0"
          />
        ) : null
      }
      label={
        selected
          ? settingsScopeEnvironmentLabel(selected, environments)
          : environmentValue !== ALL_ENVIRONMENTS_VALUE
            ? t("Unavailable environment")
            : singleEnvironment
              ? t("No environments")
              : t("All environments")
      }
      value={environmentValue}
      onChange={(next) => onChange(selectEnvironmentAxis(value, next))}
      searchLabel={t("Search environments")}
      allOption={
        singleEnvironment
          ? null
          : {
              value: ALL_ENVIRONMENTS_VALUE,
              label: t("All environments"),
              icon: <LayersIcon aria-hidden className="size-3.5 shrink-0" />,
            }
      }
      options={options.map((environment) => {
        const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
        return {
          value: environment.environmentId,
          label: primary,
          secondary:
            environments.length <= 1
              ? ""
              : secondary || settingsScopeEnvironmentAddress(environment),
          icon: (
            <EnvironmentMachineIcon
              aria-hidden
              kind={resolveEnvironmentMachineKind(environment.serverConfig)}
              className="size-3.5 shrink-0"
            />
          ),
          offline: environment.connection.phase !== "connected",
        };
      })}
    />
  );
}

function ProjectScopeMenu({ value, groups, environments, onChange }: SettingsScopeMenuProps) {
  const t = useUiTranslation();
  const { projectTypeFilter } = useSettingsScope();
  const filterLabel = t(
    projectTypeFilter === "repo" ? "Projects" : projectTypeFilter === "group" ? "Groups" : "All",
  );
  const selected = groups.find((group) => group.projectKey === value.project);
  const projects = projectScopeMenuGroups(groups, value, projectTypeFilter).map((group) => ({
    group,
    machines: settingsScopeProjectMachines(group, environments, true).join(", "),
  }));
  return (
    <ScopeMenu
      ariaLabel={t("Project scope")}
      icon={selected ? <ProjectFavicon project={selected} className="size-3.5 shrink-0" /> : null}
      label={selected?.displayName ?? (value.project ? t("Unavailable project") : filterLabel)}
      displayLabel={
        selected ? <ProjectLabel name={selected.displayName} project={selected} /> : undefined
      }
      value={projectAxisValue(value)}
      onChange={(next) => onChange(selectProjectAxis(value, next))}
      searchLabel={t("Search projects")}
      searchable
      header={<ProjectTypeFilterControl />}
      allOption={{ value: ALL_PROJECTS_VALUE, label: filterLabel }}
      options={projects.map(({ group, machines }) => {
        const sameName = projects.filter(
          (other) =>
            other.group.projectKey !== group.projectKey &&
            other.group.displayName === group.displayName,
        );
        const location =
          sameName.length === 0
            ? environments.length > 1
              ? group.workspaceRoot
              : ""
            : sameName.some((other) => other.machines === machines)
              ? `${machines} · ${group.workspaceRoot}`
              : machines;
        return {
          value: group.projectKey,
          label: group.displayName,
          displayLabel: <ProjectLabel name={group.displayName} project={group} />,
          secondary: group.archived
            ? [t("Archived"), location].filter(Boolean).join(" · ")
            : location,
          icon: <ProjectFavicon project={group} className="size-3.5 shrink-0" />,
        };
      })}
    />
  );
}

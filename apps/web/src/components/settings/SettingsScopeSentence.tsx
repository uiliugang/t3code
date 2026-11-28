import { EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { fileDisplayName } from "@t3tools/shared/path";
import {
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  InfoIcon,
  LayersIcon,
  PanelsTopLeftIcon,
} from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { useMessages } from "gt-react";

import { cn } from "../../lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
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
import { resolveApplicationTransferEnvironment } from "./ConfigurationSettings";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { ProjectTypeFilterControl } from "./ProjectTypeFilterControl";
import { isConnectedWithConfig } from "./scopedSettings";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import {
  ALL_CHECKOUTS_VALUE,
  ALL_ENVIRONMENTS_VALUE,
  ALL_PROJECTS_VALUE,
  environmentAxisValue,
  projectAxisValue,
  projectScopeMenuGroups,
  selectCheckoutAxis,
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeCheckoutChoices,
  settingsScopeCheckoutLabel,
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabel,
  settingsScopeEnvironmentLabels,
  settingsScopeProjectMachines,
} from "./settingsScopeAxis";
import { useAccessEnvironment } from "./useAccessEnvironment";
import {
  resolveEnvironmentSettingSelection,
  supportsPeerLinks,
} from "./useEnvironmentSettingTargets";
import { useRenderedSettingsPathname } from "./useRenderedSettingsPathname";

export const SETTINGS_DEVICE_ONLY_PATHS: ReadonlySet<string> = new Set([
  "/settings/general",
  "/settings/appearance",
  "/settings/chat",
  "/settings/diffs",
  "/settings/connections",
  "/settings/access",
  "/settings/about",
  "/settings/open-source-licenses",
]);

const SETTINGS_NO_SCOPE_HEADER_PATHS: ReadonlySet<string> = new Set([
  "/settings/appearance",
  "/settings/diffs",
  "/settings/about",
  "/settings/open-source-licenses",
]);

interface SettingsScopeMenuProps {
  readonly value: SettingsScopeSearch;
  readonly groups: readonly SidebarProjectSnapshot[];
  readonly environments: readonly EnvironmentPresentation[];
  readonly singleEnvironment: boolean;
  readonly onChange: (next: SettingsScopeSearch) => void;
}

function AccessHeaderEnvironmentScopeMenu({
  machine,
  className,
  onChange,
}: {
  readonly machine: string | undefined;
  readonly className?: string | undefined;
  readonly onChange: (next: SettingsScopeSearch) => void;
}) {
  const requested = machine ? EnvironmentId.make(machine) : null;
  const { candidates, environment } = useAccessEnvironment(requested);
  if (candidates.length === 0 || environment === null) return null;
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}>
      <EnvironmentScopeMenu
        value={{ machine: environment.environmentId }}
        groups={[]}
        environments={candidates}
        singleEnvironment
        onChange={(next) => onChange({ machine: next.machine })}
      />
    </div>
  );
}

export function SettingsScopeSentence({
  pathname: pathnameProp,
  className,
}: {
  readonly pathname?: string;
  readonly className?: string;
} = {}) {
  const t = useUiTranslation();
  const scope = useOptionalSettingsScope();
  const renderedPathname = useRenderedSettingsPathname();
  const pathname = pathnameProp ?? renderedPathname;
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (scope === null || SETTINGS_NO_SCOPE_HEADER_PATHS.has(pathname)) return null;

  const containerClassName = cn("flex min-w-0 flex-wrap items-center gap-1.5", className);

  if (pathname === "/settings/access") {
    return (
      <AccessHeaderEnvironmentScopeMenu
        machine={scope.search.machine}
        className={className}
        onChange={scope.selectScope}
      />
    );
  }

  if (pathname === "/settings/general") {
    const connectedEnvironments = environments.filter(isConnectedWithConfig);
    const environment = resolveApplicationTransferEnvironment(
      connectedEnvironments,
      scope.search.machine,
      scope.scope,
      primaryEnvironmentId,
    );
    if (connectedEnvironments.length === 0 || environment === null) return null;
    return (
      <div className={containerClassName}>
        <EnvironmentScopeMenu
          value={{ machine: environment.environmentId }}
          groups={[]}
          environments={connectedEnvironments}
          singleEnvironment
          onChange={(next) => scope.selectScope({ machine: next.machine })}
        />
      </div>
    );
  }

  if (pathname === "/settings/chat") {
    if (environments.length === 0) return null;
    const selected = resolveEnvironmentSettingSelection(
      environments,
      scope.search.machine,
      primaryEnvironmentId,
    );
    return (
      <div className={containerClassName}>
        <EnvironmentScopeMenu
          value={selected === null ? {} : { machine: selected }}
          groups={[]}
          environments={environments}
          singleEnvironment={environments.length === 1}
          onChange={(next) => scope.selectScope({ machine: next.machine })}
        />
      </div>
    );
  }

  if (pathname === "/settings/connections") {
    const candidates = environments.filter(supportsPeerLinks);
    if (candidates.length === 0) return null;
    const selected = resolveEnvironmentSettingSelection(
      candidates,
      scope.search.machine,
      primaryEnvironmentId,
    );
    return (
      <div className={containerClassName}>
        <EnvironmentScopeMenu
          value={selected === null ? {} : { machine: selected }}
          groups={[]}
          environments={candidates}
          singleEnvironment={candidates.length === 1}
          onChange={(next) => scope.selectScope({ machine: next.machine })}
        />
      </div>
    );
  }

  const props: SettingsScopeMenuProps = {
    value: scope.search,
    singleEnvironment: scope.singleEnvironment,
    groups: scope.groups,
    environments,
    onChange: scope.selectScope,
  };

  if (pathname === "/settings/skills") {
    return (
      <div className={containerClassName}>
        <EnvironmentScopeMenu
          {...props}
          value={{ machine: props.value.machine }}
          onChange={(next) => scope.selectScope({ machine: next.machine })}
        />
      </div>
    );
  }

  const projectSettingsHint = t(
    "Can't find a setting? Keep this project picked above and hop to any other settings page.",
  );
  return (
    <div className={containerClassName}>
      <EnvironmentScopeMenu {...props} />
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
          <TooltipPopup side="bottom" align="end">
            {projectSettingsHint}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <CheckoutScopeMenu {...props} />
    </div>
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
      className="min-w-0 max-w-[min(100%,14rem)] shrink"
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
        <ComboboxPopup align="end" className="w-80">
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
      <MenuPopup align="end">
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

function EnvironmentScopeMenu({
  value,
  groups,
  environments,
  onChange,
  singleEnvironment,
}: SettingsScopeMenuProps) {
  const t = useUiTranslation();
  const messages = useMessages();
  const resolved = resolveSettingsScope(value, groups, environments, messages);
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
        ) : environmentValue === ALL_ENVIRONMENTS_VALUE && !singleEnvironment ? (
          <LayersIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
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

function CheckoutScopeMenu({ value, groups, onChange }: SettingsScopeMenuProps) {
  const t = useUiTranslation();
  const group = groups.find((candidate) => candidate.projectKey === value.project);
  const checkouts = group ? settingsScopeCheckoutChoices(group, value) : [];
  if (checkouts.length === 0) return null;
  const selected = checkouts.find((member) => member.physicalProjectKey === value.checkout);
  return (
    <ScopeMenu
      ariaLabel={t("Checkout scope")}
      icon={<FolderIcon aria-hidden className="size-3.5 shrink-0" />}
      label={
        selected
          ? settingsScopeCheckoutLabel(selected, checkouts)
          : value.checkout
            ? t("Unavailable checkout")
            : t("All checkouts")
      }
      value={value.checkout ?? ALL_CHECKOUTS_VALUE}
      onChange={(next) =>
        onChange(
          selectCheckoutAxis(
            value,
            checkouts.find((member) => member.physicalProjectKey === next) ?? null,
          ),
        )
      }
      searchLabel={t("Search checkouts")}
      allOption={{ value: ALL_CHECKOUTS_VALUE, label: t("All checkouts") }}
      options={checkouts.map((member) => ({
        value: member.physicalProjectKey,
        label: fileDisplayName(member.workspaceRoot),
        secondary: member.workspaceRoot,
      }))}
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
      icon={
        selected ? (
          <ProjectFavicon project={selected} className="size-3.5 shrink-0" />
        ) : (
          <PanelsTopLeftIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        )
      }
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

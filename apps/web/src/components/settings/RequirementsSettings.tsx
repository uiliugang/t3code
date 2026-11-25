import { useAtomValue } from "@effect/atom-react";
import {
  isMeituanServiceEnabled,
  mergeProjectIssueSources,
  projectIssueProvider,
  MAX_WORK_ITEM_DISCOVERY_LIMIT,
  WorkItemDiscoveryLimit,
  type IssueSource,
  type IssueSourcesResult,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import {
  ChevronDownIcon,
  GithubIcon,
  RefreshCwIcon,
  SaveIcon,
  Settings2Icon,
  SquarePenIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { Fragment, useId, useState } from "react";
import {
  meituanAssociationCountLabel,
  mepSpaceSummary,
} from "@t3tools/client-runtime/meituanSettings";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { MepIcon } from "../Icons";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  parseMepSpaceIds,
  projectIssueSourceEdit,
  withMepSpaceOverrides,
} from "@t3tools/client-runtime/issueSources";
import { useSettingsScope } from "./SettingsScopeContext";
import { IssueTrackerSettings } from "./IssueTrackerSettings";
import { MepIssueTrackerSettings } from "./MepIssueTrackerSettings";
import { SettingsPageContainer } from "./settingsLayout";

type Project = ReturnType<typeof useProjects>[number];
const projectKey = (project: Project) => `${project.environmentId}/${project.id}`;

function SourceValue({ value }: { value: string | null | undefined }) {
  return value ? (
    <Tooltip>
      <TooltipTrigger render={<span className="block min-w-0 truncate" tabIndex={0} />}>
        {value}
      </TooltipTrigger>
      <TooltipPopup>{value}</TooltipPopup>
    </Tooltip>
  ) : (
    <span className="text-muted-foreground">-</span>
  );
}

type Environment = ReturnType<typeof useSettingsScope>["connectedEnvironments"][number];
type Group = { environment: Environment; projects: Project[] };
type SourceProviderFilter = "all" | "github" | "meituan";
type SourceModeFilter = "all" | "automatic" | "manual";

function matchesProjectSourceFilters(
  project: Project,
  result: (typeof IssueSourcesResult.Type)[number] | undefined,
  saved: readonly IssueSource[],
  filters: { name: string; provider: SourceProviderFilter; mode: SourceModeFilter },
) {
  if (!project.title.toLocaleLowerCase().includes(filters.name.trim().toLocaleLowerCase()))
    return false;
  if (filters.provider === "all" && filters.mode === "all") return true;
  const overridden = new Set(saved.map((source) => source.provider));
  return mergeProjectIssueSources(
    result?.sources ?? [],
    saved,
    result?.provider ?? project.repositoryIdentity?.provider,
  ).some(
    (source) =>
      (filters.provider === "all" || source.provider === filters.provider) &&
      (filters.mode === "all" ||
        (filters.mode === "manual"
          ? overridden.has(source.provider)
          : !overridden.has(source.provider))),
  );
}

const isDiscoveryLimit = Schema.is(WorkItemDiscoveryLimit);

function DiscoveredTasksSettings({
  environment,
  multiple,
}: {
  environment: Environment;
  multiple: boolean;
}) {
  const t = useUiTranslation();
  const { environmentId, label } = environment;
  const { workItemDiscoveryEnabled, workItemDiscoveryLimit } = useEnvironmentSettings(
    environmentId,
    (settings) => settings,
  );
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputId = useId();
  const limit = Number(draft ?? workItemDiscoveryLimit);
  const valid = isDiscoveryLimit(limit);
  const disabled = !allowed || saving;
  const save = async (patch: ServerSettingsPatch) => {
    setSaving(true);
    const result = await update({ environmentId, input: { patch } });
    if (result._tag === "Success" && patch.workItemDiscoveryLimit !== undefined) setDraft(null);
    setSaving(false);
  };

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">
        {multiple
          ? t("Discovered tasks · {environment}", { environment: label })
          : t("Discovered tasks")}
      </h2>
      <Collapsible>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={`${inputId}-enabled`}>{t("Enable task discovery")}</Label>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <CollapsibleTrigger
                    render={<Button variant="ghost-muted" size="icon-sm" />}
                    className="group"
                    aria-label={t("Maximum discovered tasks")}
                  >
                    <ChevronDownIcon
                      aria-hidden
                      className="size-3.5 group-data-panel-open:rotate-180"
                    />
                  </CollapsibleTrigger>
                }
              />
              <TooltipPopup>{t("Maximum discovered tasks")}</TooltipPopup>
            </Tooltip>
            <Switch
              id={`${inputId}-enabled`}
              checked={workItemDiscoveryEnabled}
              disabled={disabled}
              onCheckedChange={(workItemDiscoveryEnabled) =>
                void save({ workItemDiscoveryEnabled })
              }
            />
          </div>
        </div>
        <CollapsiblePanel animate={false}>
          <form
            className="flex items-center gap-2 pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!disabled && valid && limit !== workItemDiscoveryLimit) {
                void save({ workItemDiscoveryLimit: limit });
              }
            }}
          >
            <Label htmlFor={inputId}>{t("Maximum discovered tasks")}</Label>
            <div className="w-28 min-w-0">
              <Input
                id={inputId}
                type="number"
                min={1}
                max={MAX_WORK_ITEM_DISCOVERY_LIMIT}
                placeholder={`1-${MAX_WORK_ITEM_DISCOVERY_LIMIT}`}
                value={draft ?? workItemDiscoveryLimit}
                disabled={disabled}
                aria-invalid={!valid}
                onChange={(event) => setDraft(event.target.value)}
              />
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={disabled || !valid || limit === workItemDiscoveryLimit}
            >
              {t("Save")}
            </Button>
          </form>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

function useProjectSources({ environment, projects }: Group) {
  return useEnvironmentQuery(
    projects.length
      ? sourceControlEnvironment.issueSources({
          environmentId: environment.environmentId,
          input: { projectIds: projects.map((p) => p.id) },
        })
      : null,
  );
}

function EnvironmentTrackers({
  group,
  multiple,
  anchor,
}: {
  group: Group;
  multiple: boolean;
  anchor: boolean;
}) {
  const t = useUiTranslation();
  const { environment, projects } = group;
  const { environmentId, label } = environment;
  const settings = useEnvironmentSettings(environmentId, (value) => value);
  const enabled = isMeituanServiceEnabled(settings, "requirements");
  const caps = environment.serverConfig!.environment.capabilities;
  const query = useProjectSources({ environment, projects: enabled ? projects : [] });
  const byId = new Map(query.data?.map((row) => [row.projectId, row]));
  const associated = projects.filter((project) => {
    const row = byId.get(project.id);
    return mergeProjectIssueSources(
      row?.sources ?? [],
      settings.issueProjectSources[project.id] ?? [],
      row?.provider ?? project.repositoryIdentity?.provider,
    ).some((source) => source.provider === "meituan");
  });
  return (
    <IssueTrackerSettings
      environmentId={environmentId}
      anchor={anchor}
      standalone={caps.issues === true}
      title={
        multiple ? t("Issue trackers · {environment}", { environment: label }) : t("Issue trackers")
      }
    >
      {enabled ? (
        <MepIssueTrackerSettings
          environmentId={environmentId}
          label={label}
          supported={caps.meituanTools === true}
          projects={meituanAssociationCountLabel(projects.length, query, associated.length, t)}
        />
      ) : null}
    </IssueTrackerSettings>
  );
}

function ProjectSourceRow({
  project,
  checked,
  disabled,
  toggle,
  canEdit,
  result,
  error,
  loading,
  group,
}: {
  project: Project;
  checked: boolean;
  disabled: boolean;
  toggle: () => void;
  canEdit: boolean;
  result: (typeof IssueSourcesResult.Type)[number] | undefined;
  error: string | null;
  loading: boolean;
  group: Group;
}) {
  const t = useUiTranslation();
  const settings = useEnvironmentSettings(project.environmentId, (value) => value);
  const saved = settings.issueProjectSources[project.id] ?? [];
  const enabled = isMeituanServiceEnabled(settings, "requirements");
  const kind = result?.provider ?? project.repositoryIdentity?.provider;
  const sources = mergeProjectIssueSources(result?.sources ?? [], saved, kind);
  const provider = projectIssueProvider(kind, sources);
  const githubSources = sources.filter((entry) => entry.provider === "github");
  const manualGithub = saved.some((entry) => entry.provider === "github");
  const discovery = error || result?.error ? "failed" : result ? "ready" : "pending";
  const spaces = sources
    .filter((entry) => entry.provider === "meituan")
    .map((entry) => entry.scope);
  const manual = saved.some((entry) => entry.provider === "meituan");
  const showMepEditor =
    enabled && provider !== "github" && (provider === "meituan" || discovery === "ready");
  const [draft, setDraft] = useState<{ text: string; saved: typeof saved } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const inputId = `mep-spaces-${projectKey(project)}`;
  const submit = async (ids: string[] | null) => {
    if (!ids || !draft || saving || disabled || !showMepEditor) return;
    const input = projectIssueSourceEdit(project.id, "meituan", saved, draft.saved, () =>
      withMepSpaceOverrides(ids),
    );
    if (!input) {
      setFailure(t("Project sources have changed. Reopen the editor and try again."));
      return;
    }
    setSaving(true);
    setFailure(null);
    const response = await update({ environmentId: project.environmentId, input });
    setSaving(false);
    if (response._tag === "Success") {
      setDraft(null);
    } else setFailure(t("Could not save project sources. Reopen the editor and try again."));
  };
  const invalid = draft !== null && !parseMepSpaceIds(draft.text);
  return (
    <tr className="group/project-source grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-border py-3 text-sm lg:table-row">
      <td className="row-span-4 align-top lg:py-4 lg:pr-3">
        <Checkbox
          id={`issue-source-${projectKey(project)}`}
          checked={checked}
          disabled={disabled || saving}
          onCheckedChange={toggle}
          aria-label={t("Select {project}", { project: project.title })}
        />
      </td>
      <td className="min-w-0 align-top lg:py-4 lg:pr-4">
        <label htmlFor={`issue-source-${projectKey(project)}`} className="block font-medium">
          <SourceValue value={project.title} />
        </label>
      </td>
      <td className="col-start-2 min-w-0 align-top text-xs text-muted-foreground lg:py-4 lg:pr-4">
        <SourceValue value={result?.repository} />
        {loading && !result ? <p>{t("Loading...")}</p> : null}
        {error || result?.error ? (
          <p role="alert" className="text-destructive">
            {t(error ?? result!.error!)}
          </p>
        ) : null}
      </td>
      <td className="col-start-2 min-w-0 space-y-1 align-top lg:py-4 lg:pr-3">
        {githubSources.map((github) => (
          <p
            key={JSON.stringify([github.host, github.scope])}
            className="flex min-w-0 items-center gap-1.5 text-xs wrap-anywhere"
          >
            <GithubIcon aria-hidden className="size-3.5 shrink-0" />
            <span>
              {t("GitHub Issues")}
              {manualGithub || githubSources.length > 1 ? ` · ${github.host}/${github.scope}` : ""}
              {manualGithub ? ` · ${t("Manual override")}` : ""}
            </span>
          </p>
        ))}
        {showMepEditor ? (
          <>
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs wrap-anywhere">
                <MepIcon aria-hidden className="size-3.5 shrink-0" />
                <span>{mepSpaceSummary(spaces, manual, discovery, t)}</span>
              </p>
              {draft === null ? (
                <span className="flex shrink-0 opacity-0 group-focus-within/project-source:opacity-100 group-hover/project-source:opacity-100 any-pointer-coarse:opacity-100">
                  <Button
                    variant="ghost-muted"
                    size="icon-xs"
                    disabled={disabled}
                    aria-label={t("Edit MEP spaces for {project}", { project: project.title })}
                    onClick={() => {
                      setFailure(null);
                      setDraft({ text: spaces.join(", "), saved });
                    }}
                  >
                    <SquarePenIcon aria-hidden className="size-3.5" />
                  </Button>
                </span>
              ) : null}
            </div>
            {draft !== null ? (
              <form
                className="grid gap-2 pt-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit(parseMepSpaceIds(draft.text));
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (!saving) setDraft(null);
                }}
              >
                <Label htmlFor={inputId}>{t("MEP space IDs")}</Label>
                <Input
                  id={inputId}
                  value={draft.text}
                  disabled={saving || disabled}
                  aria-invalid={Boolean(invalid)}
                  aria-describedby={invalid ? inputId + "-error" : undefined}
                  placeholder="10001, 10002"
                  onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                />
                {invalid ? (
                  <p id={inputId + "-error"} className="text-xs text-destructive">
                    {t("Enter positive space IDs separated by commas.")}
                  </p>
                ) : null}
                {failure ? (
                  <p role="alert" className="text-xs text-destructive">
                    {failure}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-1">
                  <Button type="submit" size="xs" disabled={Boolean(invalid) || disabled || saving}>
                    {t("Save")}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => setDraft(null)}
                  >
                    {t("Cancel")}
                  </Button>
                  {manual ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost-muted"
                      disabled={disabled || saving}
                      onClick={() => void submit([])}
                    >
                      {t("Restore MEP automatic")}
                    </Button>
                  ) : null}
                </div>
              </form>
            ) : null}
          </>
        ) : null}
      </td>
      <td className="col-start-2 align-top text-xs text-muted-foreground lg:py-4 lg:text-right">
        <SourceValue value={group.environment.label} />
        {!canEdit ? <p>{t("Read-only")}</p> : null}
      </td>
    </tr>
  );
}

function EnvironmentProjectRows({
  group,
  selected,
  busy,
  canWrite,
  toggle,
}: {
  group: Group;
  selected: readonly string[];
  busy: boolean;
  canWrite: boolean;
  toggle: (key: string) => void;
}) {
  const enabled = useEnvironmentSettings(group.environment.environmentId, (settings) =>
    isMeituanServiceEnabled(settings, "requirements"),
  );
  const query = useProjectSources(group);
  const byId = new Map(query.data?.map((result) => [result.projectId, result]));
  return (
    <tbody className="block lg:table-row-group">
      {group.projects.map((project) => (
        <ProjectSourceRow
          key={JSON.stringify([projectKey(project), enabled])}
          project={project}
          group={group}
          result={byId.get(project.id)}
          error={query.error}
          loading={query.isPending}
          checked={selected.includes(projectKey(project))}
          canEdit={canWrite}
          disabled={busy || !canWrite}
          toggle={() => toggle(projectKey(project))}
        />
      ))}
    </tbody>
  );
}

function ProjectIssueSources({ groups }: { groups: Group[] }) {
  const t = useUiTranslation();
  const { connectedEnvironments } = useSettingsScope();
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [scope, setScope] = useState("");
  const [host, setHost] = useState("github.com");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [providerFilter, setProviderFilter] = useState<SourceProviderFilter>("all");
  const [modeFilter, setModeFilter] = useState<SourceModeFilter>("all");
  const permissions = useAtomValue(
    Atom.make(
      (get) =>
        new Map(
          connectedEnvironments.map((entry) => [
            entry.environmentId,
            get(serverEnvironment.updateSettings.permissionAtom(entry.environmentId)),
          ]),
        ),
    ),
  );
  const sourceResults = useAtomValue(
    Atom.make((get) =>
      groups.map((group) => ({
        environmentId: group.environment.environmentId,
        result: group.projects.length
          ? get(
              sourceControlEnvironment.issueSources({
                environmentId: group.environment.environmentId,
                input: { projectIds: group.projects.map((project) => project.id) },
              }),
            )
          : null,
      })),
    ),
  );
  const discoveredSources = new Map<string, (typeof IssueSourcesResult.Type)[number]>();
  for (const entry of sourceResults) {
    if (entry.result?._tag !== "Success") continue;
    for (const source of entry.result.value) {
      discoveredSources.set(`${entry.environmentId}/${source.projectId}`, source);
    }
  }
  const savedSources = new Map<string, readonly IssueSource[]>();
  for (const group of groups) {
    for (const project of group.projects) {
      savedSources.set(
        projectKey(project),
        group.environment.serverConfig?.settings.issueProjectSources[project.id] ?? [],
      );
    }
  }
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      projects: group.projects.filter((project) =>
        matchesProjectSourceFilters(
          project,
          discoveredSources.get(projectKey(project)),
          savedSources.get(projectKey(project)) ?? [],
          { name: nameFilter, provider: providerFilter, mode: modeFilter },
        ),
      ),
    }))
    .filter((group) => group.projects.length > 0);
  const visibleProjects = visibleGroups.flatMap((group) => group.projects);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const refresh = useAtomCommand(sourceControlEnvironment.refreshIssueSources);
  const writable = visibleProjects.filter((project) => permissions.get(project.environmentId));
  const chosen = writable.filter((project) => selected.includes(projectKey(project)));
  const githubChosen = chosen.filter((project) =>
    matchesProjectSourceFilters(
      project,
      discoveredSources.get(projectKey(project)),
      savedSources.get(projectKey(project)) ?? [],
      { name: "", provider: "github", mode: modeFilter },
    ),
  );
  const valid = /^[\w.-]+\/[\w.-]+$/u.test(scope.trim()) && /^[\w.-]+$/u.test(host.trim());
  const run = async (action: "refresh" | "save" | "reset") => {
    const actionTargets = action === "refresh" ? chosen : githubChosen;
    if (!actionTargets.length || busy || (action === "save" && !valid)) return;
    setBusy(true);
    setMessage("");
    const results = await Promise.all(
      connectedEnvironments.map(async (environment) => {
        const targets = actionTargets.filter(
          (project) => project.environmentId === environment.environmentId,
        );
        if (!targets.length) return { success: 0, failed: 0 };
        if (action === "refresh") {
          const result = await refresh({
            environmentId: environment.environmentId,
            input: { projectIds: targets.map((project) => project.id), refresh: true },
          });
          const failed =
            result._tag === "Success"
              ? result.value.filter((entry) => entry.error).length
              : targets.length;
          return { success: targets.length - failed, failed };
        }
        const saved = environment.serverConfig!.settings.issueProjectSources;
        const entries = Object.fromEntries(
          targets.map((project) => [
            project.id,
            action === "reset"
              ? []
              : [{ provider: "github" as const, scope: scope.trim(), host: host.trim() }],
          ]),
        );
        const result = await update({
          environmentId: environment.environmentId,
          input: {
            patch: { issueProjectSources: entries },
            expectedIssueProjectSources: Object.fromEntries(
              targets.map((project) => [project.id, saved[project.id] ?? []]),
            ),
            issueSourceProvider: "github" as const,
          },
        });
        return {
          success: result._tag === "Success" ? targets.length : 0,
          failed: result._tag === "Success" ? 0 : targets.length,
        };
      }),
    );
    setMessage(
      t("Completed: {success} succeeded, {failed} failed.", {
        success: String(results.reduce((sum, result) => sum + result.success, 0)),
        failed: String(results.reduce((sum, result) => sum + result.failed, 0)),
      }),
    );
    if (!results.some((result) => result.failed)) setEditing(false);
    setBusy(false);
  };
  return (
    <section id="issue-project-sources" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{t("Project issue sources")}</h2>
        <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
          <div className="w-44 max-sm:flex-1">
            <Input
              size="compact"
              type="search"
              value={nameFilter}
              aria-label={t("Project name")}
              placeholder={t("Project name")}
              onChange={(event) => setNameFilter(event.target.value)}
            />
          </div>
          <Select
            value={providerFilter}
            onValueChange={(value) => setProviderFilter(value as SourceProviderFilter)}
          >
            <SelectTrigger size="compact" className="w-32" aria-label={t("Issue source")}>
              <SelectValue>
                {providerFilter === "all"
                  ? t("All sources")
                  : providerFilter === "github"
                    ? t("GitHub Issues")
                    : t("MEP ONES")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              <SelectItem value="all">{t("All sources")}</SelectItem>
              <SelectItem value="github">{t("GitHub Issues")}</SelectItem>
              <SelectItem value="meituan">{t("MEP ONES")}</SelectItem>
            </SelectPopup>
          </Select>
          <Select
            value={modeFilter}
            onValueChange={(value) => setModeFilter(value as SourceModeFilter)}
          >
            <SelectTrigger size="compact" className="w-28" aria-label={t("Source mode")}>
              <SelectValue>
                {modeFilter === "all"
                  ? t("All modes")
                  : modeFilter === "automatic"
                    ? t("Automatic")
                    : t("Manual")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              <SelectItem value="all">{t("All modes")}</SelectItem>
              <SelectItem value="automatic">{t("Automatic")}</SelectItem>
              <SelectItem value="manual">{t("Manual")}</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            aria-label={t("Select all results")}
            checked={chosen.length > 0 && chosen.length === writable.length}
            indeterminate={chosen.length > 0 && chosen.length < writable.length}
            disabled={busy || !writable.length}
            onCheckedChange={(checked) => setSelected(checked ? writable.map(projectKey) : [])}
          />
          {t("Select all results")}
        </label>
        <span className="text-xs text-muted-foreground">
          {t("{count} selected", { count: String(chosen.length) })}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !chosen.length}
          onClick={() => void run("refresh")}
        >
          <RefreshCwIcon />
          {t("Detect again")}
        </Button>
        {githubChosen.length > 0 ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setEditing(!editing);
                setScope("");
              }}
            >
              <Settings2Icon />
              {t("GitHub override")}
              <span className="text-xs text-muted-foreground">{githubChosen.length}</span>
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("reset")}>
              <Undo2Icon />
              {t("Restore GitHub automatic")}
              <span className="text-xs text-muted-foreground">{githubChosen.length}</span>
            </Button>
          </>
        ) : null}
      </div>
      {editing && githubChosen.length ? (
        <form
          className="grid grid-cols-1 gap-3 rounded-xl border border-border bg-muted/20 p-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run("save");
          }}
        >
          <div className="flex items-start justify-between gap-3 sm:col-span-2">
            <div className="space-y-1">
              <h3 className="text-sm font-medium">{t("GitHub Issue repository override")}</h3>
              <p className="text-xs text-muted-foreground">
                {t(
                  "Only changes the selected projects' GitHub Issue sources. MEP ONES spaces are not affected.",
                )}
              </p>
            </div>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              aria-label={t("Close")}
              onClick={() => setEditing(false)}
            >
              <XIcon />
            </Button>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="issue-source-scope">{t("GitHub repository")}</Label>
            <Input
              id="issue-source-scope"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              placeholder="owner/repository"
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="issue-source-host">{t("GitHub host")}</Label>
            <Input
              id="issue-source-host"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              disabled={busy}
            />
          </div>
          <div className="flex justify-end sm:col-span-2">
            <Button size="sm" type="submit" disabled={busy || !valid}>
              <SaveIcon />
              {t("Save GitHub override")}
            </Button>
          </div>
        </form>
      ) : null}
      {message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="block w-full lg:table lg:table-fixed">
          <colgroup className="hidden lg:table-column-group">
            <col className="w-7" />
            <col className="w-[28%]" />
            <col className="w-[30%]" />
            <col />
            <col className="w-20" />
          </colgroup>
          <thead className="hidden lg:table-header-group border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th aria-label={t("Select all results")} />
              <th scope="col" className="pb-3 pr-4 font-normal">
                {t("Project")}
              </th>
              <th scope="col" className="pb-3 pr-4 font-normal">
                {t("Repository")}
              </th>
              <th scope="col" className="pb-3 pr-4 font-normal">
                {t("Issue source")}
              </th>
              <th scope="col" className="pb-3 text-right font-normal">
                {t("Environment")}
              </th>
            </tr>
          </thead>
          {visibleGroups.map((group) => (
            <EnvironmentProjectRows
              key={group.environment.environmentId}
              group={group}
              selected={selected}
              busy={busy}
              canWrite={permissions.get(group.environment.environmentId) === true}
              toggle={(key) =>
                setSelected((current) =>
                  current.includes(key)
                    ? current.filter((value) => value !== key)
                    : [...current, key],
                )
              }
            />
          ))}
        </table>
      </div>
      {!visibleProjects.length ? (
        <p className="text-sm text-muted-foreground">{t("No matching projects.")}</p>
      ) : null}
    </section>
  );
}

export function RequirementsSettings() {
  const t = useUiTranslation();
  const { scope, search, environments, connectedEnvironments } = useSettingsScope();
  const projects = useProjects().filter(
    (project) =>
      !project.isScratch &&
      connectedEnvironments.some((entry) => entry.environmentId === project.environmentId) &&
      (scope.kind === "project" || scope.kind === "checkout"
        ? scope.members.some(
            (member) => member.id === project.id && member.environmentId === project.environmentId,
          )
        : true),
  );
  const groups = connectedEnvironments.map((environment) => ({
    environment,
    projects: projects.filter((p) => p.environmentId === environment.environmentId),
  }));
  return (
    <SettingsPageContainer>
      {environments
        .filter((entry) => entry.connection.phase !== "connected")
        .map((entry) => (
          <p key={entry.environmentId} role="status" className="text-sm text-muted-foreground">
            {entry.label} · {t("Offline")}
          </p>
        ))}
      {groups.map((group, index) => (
        <Fragment key={group.environment.environmentId}>
          <EnvironmentTrackers group={group} multiple={groups.length > 1} anchor={index === 0} />
          {group.environment.serverConfig?.workItemDiscoverySettings ? (
            <DiscoveredTasksSettings environment={group.environment} multiple={groups.length > 1} />
          ) : null}
        </Fragment>
      ))}
      <ProjectIssueSources
        key={`${JSON.stringify(search)}/${projects.map(projectKey).join(",")}`}
        groups={groups}
      />
    </SettingsPageContainer>
  );
}

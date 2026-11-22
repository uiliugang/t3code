import { useAtomValue } from "@effect/atom-react";
import { isMeituanServiceEnabled, type IssueSourcesResult } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { RefreshCwIcon, Settings2Icon, Undo2Icon, SaveIcon } from "lucide-react";
import { useState } from "react";
import { meituanAssociationCountLabel } from "@t3tools/client-runtime/meituanSettings";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  mergeProjectIssueSources,
  parseMepSpaceIds,
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
  const associated = new Set(
    query.data
      ?.filter((row) => row.sources.some((source) => source.provider === "meituan"))
      .map((row) => row.projectId),
  );
  for (const project of projects) {
    if (settings.issueProjectSources[project.id]?.some((source) => source.provider === "meituan"))
      associated.add(project.id);
  }
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
          projects={meituanAssociationCountLabel(projects.length, query, associated.size, t)}
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
  const sources = mergeProjectIssueSources(result?.sources ?? [], saved);
  const github = sources.find((entry) => entry.provider === "github");
  const spaces = sources
    .filter((entry) => entry.provider === "meituan")
    .map((entry) => entry.scope);
  const manual = saved.some((entry) => entry.provider === "meituan");
  const [draft, setDraft] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const inputId = `mep-spaces-${projectKey(project)}`;
  const submit = async (ids: string[] | null) => {
    if (!ids || saving || disabled || !enabled) return;
    setSaving(true);
    setFailure(null);
    const response = await update({
      environmentId: project.environmentId,
      input: {
        issueSourceProvider: "meituan",
        patch: { issueProjectSources: { [project.id]: withMepSpaceOverrides(saved, ids) } },
      },
    });
    setSaving(false);
    if (response._tag === "Success") {
      setDraft(null);
    } else setFailure(t("Could not save project sources. Try again."));
  };
  const invalid = draft !== null && !parseMepSpaceIds(draft);
  return (
    <tr className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-border py-3 text-sm sm:table-row">
      <td className="row-span-4 align-top sm:py-4 sm:pr-3">
        <Checkbox
          id={`issue-source-${projectKey(project)}`}
          checked={checked}
          disabled={disabled || saving}
          onCheckedChange={toggle}
          aria-label={t("Select {project}", { project: project.title })}
        />
      </td>
      <td className="min-w-0 align-top sm:py-4 sm:pr-4">
        <label htmlFor={`issue-source-${projectKey(project)}`} className="block font-medium">
          <SourceValue value={project.title} />
        </label>
      </td>
      <td className="col-start-2 min-w-0 align-top text-xs text-muted-foreground sm:py-4 sm:pr-4">
        <SourceValue value={result?.repository} />
        {loading && !result ? <p>{t("Loading...")}</p> : null}
        {error || result?.error ? (
          <p role="alert" className="text-destructive">
            {t(error ?? result!.error!)}
          </p>
        ) : null}
      </td>
      <td className="col-start-2 min-w-0 space-y-1 align-top sm:py-4 sm:pr-3">
        {github ? (
          <p className="text-xs wrap-anywhere">
            {t("GitHub Issues")}
            {saved.some((source) => source.provider === "github")
              ? ` · ${github.host}/${github.scope} · ${t("Manual override")}`
              : ""}
          </p>
        ) : null}
        {enabled ? (
          <>
            <p className="text-xs wrap-anywhere">
              {spaces.length
                ? `${t("MEP space IDs")} · ${spaces.join(", ")} · ${t(manual ? "Manual override" : "Automatic")}`
                : t("No MEP space linked")}
            </p>
            {draft === null ? (
              <Button
                variant="ghost-muted"
                size="xs"
                disabled={disabled}
                onClick={() => {
                  setFailure(null);
                  setDraft(spaces.join(", "));
                }}
              >
                {t(spaces.length ? "Edit spaces" : "Link spaces")}
              </Button>
            ) : (
              <form
                className="grid gap-2 pt-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit(parseMepSpaceIds(draft));
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
                  value={draft}
                  disabled={saving || disabled}
                  aria-invalid={Boolean(invalid)}
                  aria-describedby={invalid ? inputId + "-error" : undefined}
                  placeholder="10001, 10002"
                  onChange={(event) => setDraft(event.target.value)}
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
                      {t("Restore automatic")}
                    </Button>
                  ) : null}
                </div>
              </form>
            )}
          </>
        ) : null}
      </td>
      <td className="col-start-2 align-top text-xs text-muted-foreground sm:py-4 sm:text-right">
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
    <tbody className="block sm:table-row-group">
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

function ProjectIssueSources({ projects, groups }: { projects: Project[]; groups: Group[] }) {
  const t = useUiTranslation();
  const { connectedEnvironments } = useSettingsScope();
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [scope, setScope] = useState("");
  const [host, setHost] = useState("github.com");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
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
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const refresh = useAtomCommand(sourceControlEnvironment.refreshIssueSources);
  const writable = projects.filter((project) => permissions.get(project.environmentId));
  const chosen = writable.filter((project) => selected.includes(projectKey(project)));
  const valid = /^[\w.-]+\/[\w.-]+$/u.test(scope.trim()) && /^[\w.-]+$/u.test(host.trim());
  const run = async (action: "refresh" | "save" | "reset") => {
    if (!chosen.length || busy || (action === "save" && !valid)) return;
    setBusy(true);
    setMessage("");
    const results = await Promise.all(
      connectedEnvironments.map(async (environment) => {
        const targets = chosen.filter(
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
              : [
                  ...(saved[project.id] ?? []).filter((source) => source.provider !== "github"),
                  { provider: "github" as const, scope: scope.trim(), host: host.trim() },
                ],
          ]),
        );
        const result = await update({
          environmentId: environment.environmentId,
          input: {
            patch: { issueProjectSources: entries },
            ...(action === "save" ? { issueSourceProvider: "github" as const } : {}),
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
      <h2 className="text-base font-semibold">{t("Project issue sources")}</h2>
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
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !chosen.length}
          onClick={() => {
            setEditing(!editing);
            setScope("");
          }}
        >
          <Settings2Icon />
          {t("Set override")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !chosen.length}
          onClick={() => void run("reset")}
        >
          <Undo2Icon />
          {t("Restore automatic")}
        </Button>
      </div>
      {editing && chosen.length ? (
        <form
          className="grid grid-cols-1 gap-3 border-t border-border py-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run("save");
          }}
        >
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
              {t("Save override")}
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
        <table className="block w-full sm:table sm:table-fixed">
          <colgroup className="hidden sm:table-column-group">
            <col className="w-7" />
            <col className="w-[28%]" />
            <col className="w-[30%]" />
            <col />
            <col className="w-20" />
          </colgroup>
          <thead className="hidden sm:table-header-group border-b border-border text-left text-xs text-muted-foreground">
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
          {groups.map((group) => (
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
      {!projects.length ? (
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
      project.title !== "No project" &&
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
        <EnvironmentTrackers
          key={group.environment.environmentId}
          group={group}
          multiple={groups.length > 1}
          anchor={index === 0}
        />
      ))}
      <ProjectIssueSources
        key={`${JSON.stringify(search)}/${projects.map(projectKey).join(",")}`}
        projects={projects}
        groups={groups}
      />
    </SettingsPageContainer>
  );
}

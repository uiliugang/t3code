import { useAtomValue } from "@effect/atom-react";
import type { IssueProvider } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { RefreshCwIcon, Settings2Icon, Undo2Icon, SaveIcon } from "lucide-react";
import { useState } from "react";
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
import { IssueSelect } from "../requirements/IssueSelect";
import { useSettingsScope } from "./SettingsScopeContext";
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

function ProjectSourceRow({
  project,
  checked,
  disabled,
  toggle,
}: {
  project: Project;
  checked: boolean;
  disabled: boolean;
  toggle: () => void;
}) {
  const t = useUiTranslation();
  const { environments } = useSettingsScope();
  const saved =
    useEnvironmentSettings(project.environmentId, (settings) => settings.issueProjectSources)[
      project.id
    ] ?? [];
  const query = useEnvironmentQuery(
    sourceControlEnvironment.issueSources({
      environmentId: project.environmentId,
      input: { projectIds: [project.id] },
    }),
  );
  const result = query.data?.[0];
  const overridden = new Set(saved.map((entry) => entry.provider));
  const sources = [
    ...(result?.sources ?? []).filter((entry) => !overridden.has(entry.provider)),
    ...saved,
  ];
  const mep = sources.filter((entry) => entry.provider === "meituan");
  const github = sources.find((entry) => entry.provider === "github");
  return (
    <tr className="border-b border-border text-sm">
      <td className="py-4 pr-3 align-top">
        <Checkbox
          id={`issue-source-${projectKey(project)}`}
          checked={checked}
          disabled={disabled}
          onCheckedChange={toggle}
          aria-label={t("Select {project}", { project: project.title })}
        />
      </td>
      <td className="py-4 pr-4 align-top">
        <label
          htmlFor={`issue-source-${projectKey(project)}`}
          className="flex min-w-0 items-center gap-2 font-medium"
        >
          <SourceValue value={project.title} />
          <span className="shrink-0 text-xs text-muted-foreground">
            {t(saved.length ? "Manual override" : "Automatic")}
          </span>
        </label>
      </td>
      <td className="py-4 pr-4 align-top">
        <SourceValue value={result?.repository} />
        {query.isPending && !result ? (
          <p className="text-xs text-muted-foreground">{t("Loading...")}</p>
        ) : null}
        {query.error || result?.error ? (
          <p role="alert" className="text-xs text-destructive">
            {t(query.error ?? result!.error!)}
          </p>
        ) : null}
      </td>
      <td className="py-4 pr-4 align-top">
        <div className="flex items-center gap-3 overflow-hidden">
          {github ? <span className="shrink-0">GitHub Issues</span> : null}
          {mep.length ? (
            <SourceValue
              value={`MEP ${[...new Set(mep.map((entry) => entry.scope))].join(", ")}`}
            />
          ) : null}
          {!github && !mep.length ? <SourceValue value={undefined} /> : null}
        </div>
      </td>
      <td className="py-4 text-right align-top text-xs text-muted-foreground">
        <SourceValue
          value={environments.find((entry) => entry.environmentId === project.environmentId)?.label}
        />
      </td>
    </tr>
  );
}

function ProjectIssueSources({ projects }: { projects: Project[] }) {
  const t = useUiTranslation();
  const { connectedEnvironments } = useSettingsScope();
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<IssueProvider>("meituan");
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
  const scopes = [
    ...new Set(
      scope
        .split(/[,，]/u)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  const valid =
    provider === "meituan"
      ? scopes.length > 0 && scopes.every((value) => /^[1-9]\d*$/u.test(value))
      : /^[\w.-]+\/[\w.-]+$/u.test(scope.trim()) && /^[\w.-]+$/u.test(host.trim());
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
                  ...(saved[project.id] ?? []).filter((source) => source.provider !== provider),
                  ...(provider === "meituan" ? scopes : [scope.trim()]).map((value) => ({
                    provider,
                    scope: value,
                    host: provider === "meituan" ? "mep.sankuai.com" : host.trim(),
                  })),
                ],
          ]),
        );
        const result = await update({
          environmentId: environment.environmentId,
          input: { patch: { issueProjectSources: entries } },
        });
        if (result._tag === "Success")
          await refresh({
            environmentId: environment.environmentId,
            input: { projectIds: targets.map((project) => project.id) },
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
            <Label>{t("Issue source")}</Label>
            <IssueSelect
              label={t("Issue source")}
              value={provider}
              options={[
                { value: "meituan", label: "MEP ONES" },
                { value: "github", label: "GitHub Issues" },
              ]}
              onChange={(value) => {
                setProvider(value === "github" ? "github" : "meituan");
                setScope("");
              }}
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="issue-source-scope">
              {t(provider === "meituan" ? "MEP space IDs" : "GitHub repository")}
            </Label>
            <Input
              id="issue-source-scope"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              placeholder={provider === "meituan" ? "1031008, 1031009" : "owner/repository"}
              disabled={busy}
            />
          </div>
          {provider === "github" ? (
            <div className="space-y-1.5">
              <Label htmlFor="issue-source-host">{t("GitHub host")}</Label>
              <Input
                id="issue-source-host"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                disabled={busy}
              />
            </div>
          ) : null}
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
        <table className="w-full min-w-160 table-fixed">
          <colgroup>
            <col className="w-7" />
            <col className="w-[28%]" />
            <col className="w-[30%]" />
            <col />
            <col className="w-20" />
          </colgroup>
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th aria-label={t("Select all results")} />
              <th scope="col" className="pb-3 pr-4 font-normal">
                {t("Project")} / {t("Automatic")}
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
          <tbody>
            {projects.map((project) => (
              <ProjectSourceRow
                key={projectKey(project)}
                project={project}
                checked={selected.includes(projectKey(project))}
                disabled={busy || !permissions.get(project.environmentId)}
                toggle={() =>
                  setSelected(
                    selected.includes(projectKey(project))
                      ? selected.filter((value) => value !== projectKey(project))
                      : [...selected, projectKey(project)],
                  )
                }
              />
            ))}
          </tbody>
        </table>
      </div>
      {!projects.length ? (
        <p className="text-sm text-muted-foreground">{t("No matching projects.")}</p>
      ) : null}
    </section>
  );
}

export function RequirementsSettings() {
  const { scope, search, connectedEnvironments } = useSettingsScope();
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
  return (
    <SettingsPageContainer>
      <ProjectIssueSources
        key={`${JSON.stringify(search)}/${projects.map(projectKey).join(",")}`}
        projects={projects}
      />
    </SettingsPageContainer>
  );
}

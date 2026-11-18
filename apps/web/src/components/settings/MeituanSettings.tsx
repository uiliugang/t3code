import { useAtomValue } from "@effect/atom-react";
import { mergeProjectIssueSources } from "@t3tools/client-runtime/issueSources";
import {
  meituanToolIdsForSection,
  shouldDiscoverMeituanProjectSources,
} from "@t3tools/client-runtime/meituanSettings";
import {
  ProjectId,
  isMeituanServiceEnabled,
  type EnvironmentId,
  type ServerSettings,
  type SkillSource,
} from "@t3tools/contracts";
import { useState, type ComponentType } from "react";
import {
  ArrowLeftIcon,
  BookOpenIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  GitBranchIcon,
  MessagesSquareIcon,
  PauseIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import { useNavigate, useLocation } from "@tanstack/react-router";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { useAtomCommand } from "~/state/use-atom-command";
import { requestConfirmDialog } from "~/confirmDialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { SettingsPageContainer } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { MeituanCodeSettings, MeituanCodeAuthorizationObserver } from "./MeituanCodeSettings";
import { DaxiangSettings } from "./DaxiangSettings";
import { SourceControlToolControls, SourceControlToolStatus } from "./SourceControlToolControls";

export type MeituanSection = "code" | "issues" | "daxiang" | "skills";

const titles = {
  code: "Source control",
  issues: "Requirements and delivery",
  daxiang: "DaXiang",
  skills: "Meituan Skills",
} as const;

function ServiceRow({
  icon: Icon,
  title,
  subtitle,
  status,
  onClick,
  toggle,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  status: string;
  onClick: () => void;
  toggle?: { checked: boolean; disabled: boolean; onChange: (value: boolean) => void };
}) {
  const t = useUiTranslation();
  return (
    <div className="flex min-h-20 items-center gap-3 border-b">
      <button
        type="button"
        className="flex min-h-20 min-w-0 flex-1 items-center gap-3 py-4 text-start hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
        onClick={onClick}
      >
        <Icon className="size-5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <span className="min-w-0">
            <span className="block text-sm font-medium">{title}</span>
            <span className="mt-1 block text-xs text-muted-foreground wrap-anywhere">
              {subtitle}
            </span>
          </span>
          <span className="text-xs text-muted-foreground sm:text-end">{status}</span>
        </span>
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {toggle ? (
        <Switch
          aria-label={t("Enable {name}", { name: title })}
          checked={toggle.checked}
          disabled={toggle.disabled}
          onCheckedChange={toggle.onChange}
        />
      ) : null}
    </div>
  );
}

function useMeituanProjectAssociations(
  environmentId: EnvironmentId,
  settings: ServerSettings,
  enabled: boolean,
) {
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && !project.isScratch,
  );
  const query = useEnvironmentQuery(
    enabled && projects.length
      ? sourceControlEnvironment.issueSources({
          environmentId,
          input: { projectIds: projects.map((project) => project.id) },
        })
      : null,
  );
  const entries = projects
    .map((project) => {
      const saved = (settings.issueProjectSources[project.id] ?? []).filter(
        (source) => source.provider === "meituan",
      );
      const automatic =
        query.data
          ?.find((result) => result.projectId === project.id)
          ?.sources.filter((source) => source.provider === "meituan") ?? [];
      return {
        project,
        manual: saved.length > 0,
        sources: mergeProjectIssueSources(automatic, saved),
      };
    })
    .filter((entry) => entry.sources.length > 0);
  const error = query.error ?? query.data?.find((result) => result.error)?.error ?? null;
  return { projects, query, entries, error };
}

function MeituanProjectSources({
  environmentId,
  settings,
  associations,
}: {
  environmentId: EnvironmentId;
  settings: ServerSettings;
  associations: ReturnType<typeof useMeituanProjectAssociations>;
}) {
  const t = useUiTranslation();
  const { projects, query, entries, error } = associations;
  const [editing, setEditing] = useState(false);
  const [projectId, setProjectId] = useState<ProjectId | undefined>();
  const [spaces, setSpaces] = useState("");
  const [busy, setBusy] = useState(false);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const values = [
    ...new Set(
      spaces
        .split(/[,，]/u)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  const save = async (remove = false) => {
    if (
      !projectId ||
      busy ||
      (!remove && (!values.length || !values.every((value) => /^[1-9]\d*$/u.test(value))))
    )
      return;
    setBusy(true);
    const result = await update({
      environmentId,
      input: {
        patch: {
          issueProjectSources: {
            [projectId]: [
              ...(settings.issueProjectSources[projectId] ?? []).filter(
                (source) => source.provider !== "meituan",
              ),
              ...(remove
                ? []
                : values.map((scope) => ({
                    provider: "meituan" as const,
                    host: "mep.sankuai.com",
                    scope,
                  }))),
            ],
          },
        },
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setEditing(false);
      query.refresh();
    }
  };
  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("Project associations")}</h3>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("Add project association")}
          title={t("Add project association")}
          onClick={() => {
            setProjectId(undefined);
            setSpaces("");
            setEditing(true);
          }}
        >
          <PlusIcon />
        </Button>
      </div>
      {entries.map((entry) => (
        <ServiceRow
          key={entry.project.id}
          icon={ClipboardListIcon}
          title={entry.project.title}
          subtitle={`MEP · ${[...new Set(entry.sources.map((source) => source.scope))].join(", ")}`}
          status={t(entry.manual ? "Edit" : "Automatic")}
          onClick={() => {
            setProjectId(entry.project.id);
            setSpaces(
              settings.issueProjectSources[entry.project.id]
                ?.filter((source) => source.provider === "meituan")
                .map((source) => source.scope)
                .join(", ") ?? "",
            );
            setEditing(true);
          }}
        />
      ))}
      {query.isPending && !entries.length ? (
        <p className="text-sm text-muted-foreground">{t("Loading...")}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(error)}
        </p>
      ) : null}
      {!query.isPending && !entries.length && !error ? (
        <p className="text-sm text-muted-foreground">{t("No project associations")}</p>
      ) : null}
      {editing ? (
        <form
          className="grid gap-4 border-t pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="meituan-project">{t("Project")}</Label>
            <Select
              value={projectId ?? ""}
              onValueChange={(value) => setProjectId(value ? ProjectId.make(value) : undefined)}
            >
              <SelectTrigger id="meituan-project" aria-label={t("Project")}>
                <SelectValue placeholder={t("Select project")}>
                  {projects.find((project) => project.id === projectId)?.title}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="meituan-spaces">{t("MEP space IDs")}</Label>
            <Input
              id="meituan-spaces"
              value={spaces}
              onChange={(event) => setSpaces(event.target.value)}
              placeholder="1031008, 1031009"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              disabled={
                busy ||
                !projectId ||
                !values.length ||
                !values.every((value) => /^[1-9]\d*$/u.test(value))
              }
            >
              <SaveIcon />
              {t("Save")}
            </Button>
            <Button type="button" variant="outline" onClick={() => setEditing(false)}>
              {t("Cancel")}
            </Button>
            {projectId &&
            settings.issueProjectSources[projectId]?.some(
              (source) => source.provider === "meituan",
            ) ? (
              <Button
                type="button"
                variant="ghost"
                aria-label={t("Remove association")}
                title={t("Remove association")}
                disabled={busy}
                onClick={() => void save(true)}
              >
                <Trash2Icon />
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}

function MeituanSkillSource({
  environmentId,
  disabled,
}: {
  environmentId: EnvironmentId;
  disabled: boolean;
}) {
  const t = useUiTranslation();
  const query = useEnvironmentQuery(serverEnvironment.skills({ environmentId, input: {} }));
  const mutate = useAtomCommand(serverEnvironment.mutateSkills);
  const allowed = useAtomValue(serverEnvironment.mutateSkills.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const source: SkillSource = query.data?.sources.find((entry) => entry.kind === "mtskills") ?? {
    id: "meituan",
    label: "Meituan Skills",
    kind: "mtskills",
    enabled: false,
    executable: "mtskills",
    registry: "http://r.npm.sankuai.com",
  };
  const run = async (input: Parameters<typeof mutate>[0]["input"]) => {
    setBusy(true);
    await mutate({ environmentId, input });
    setBusy(false);
    query.refresh();
  };
  return (
    <div className="grid gap-5">
      <dl className="grid gap-4 text-sm">
        <div className="flex justify-between gap-4">
          <dt>{t("Registry")}</dt>
          <dd className="min-w-0 text-end font-mono text-xs text-muted-foreground wrap-anywhere">
            {source.registry}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt>{t("Executable")}</dt>
          <dd className="min-w-0 text-end font-mono text-xs text-muted-foreground wrap-anywhere">
            {source.executable || "mtskills"}
          </dd>
        </div>
      </dl>
      <div>
        <Button
          variant="outline"
          disabled={
            disabled ||
            !allowed ||
            busy ||
            !query.data?.sources.some((entry) => entry.id === source.id)
          }
          onClick={() => void run({ type: "source.prepare", sourceId: source.id })}
        >
          {t("Prepare installer")}
        </Button>
      </div>
    </div>
  );
}

export function MeituanSettings({
  section,
  onSectionChange,
}: {
  section?: MeituanSection | undefined;
  onSectionChange: (next?: MeituanSection) => void;
}) {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment?.serverConfig ? (
        <EnvironmentMeituanSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
          canToggle={environment.serverConfig.environment.capabilities.meituanIntegration === true}
          section={section}
          onSectionChange={onSectionChange}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function EnvironmentMeituanSettings({
  environmentId,
  label,
  canToggle,
  section,
  onSectionChange,
}: {
  environmentId: EnvironmentId;
  label: string;
  canToggle: boolean;
  section?: MeituanSection | undefined;
  onSectionChange: (next?: MeituanSection) => void;
}) {
  const t = useUiTranslation();
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const searchSection =
    hash.includes("meituan") || hash.includes("daxiang")
      ? hash.includes("skill")
        ? "skills"
        : hash.includes("issue")
          ? "issues"
          : hash.includes("daxiang")
            ? "daxiang"
            : "code"
      : undefined;
  const active = section ?? searchSection;
  const settings = useEnvironmentSettings(environmentId, (value) => value);
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const refreshTools = useAtomCommand(sourceControlEnvironment.refreshTools);
  const [busy, setBusy] = useState(false);
  const enabled = settings.meituanIntegrationEnabled;
  const codeEnabled = isMeituanServiceEnabled(settings, "sourceControl");
  const issuesEnabled = isMeituanServiceEnabled(settings, "requirements");
  const associations = useMeituanProjectAssociations(
    environmentId,
    settings,
    issuesEnabled && shouldDiscoverMeituanProjectSources(active),
  );
  const skillQuery = useEnvironmentQuery(serverEnvironment.skills({ environmentId, input: {} }));
  const mutateSkills = useAtomCommand(serverEnvironment.mutateSkills);
  const skillsAllowed = useAtomValue(serverEnvironment.mutateSkills.permissionAtom(environmentId));
  const skillSources =
    skillQuery.data?.sources.filter((source) => source.kind === "mtskills") ?? [];
  const skillSourceEnabled = skillSources.some((source) => source.enabled);
  const skillsEnabled = enabled && skillSourceEnabled;
  const activeToolIds = meituanToolIdsForSection(active, {
    code: codeEnabled,
    issues: issuesEnabled,
    skills: skillsEnabled,
  });
  const discovery = useEnvironmentQuery(
    codeEnabled ? sourceControlEnvironment.discovery({ environmentId, input: {} }) : null,
  );
  const tools = useEnvironmentQuery(
    codeEnabled ? sourceControlEnvironment.tools({ environmentId, input: {} }) : null,
  );
  const meituanTools = useEnvironmentQuery(
    issuesEnabled || skillsEnabled
      ? sourceControlEnvironment.meituanTools({ environmentId, input: {} })
      : null,
  );
  const item = discovery.data?.sourceControlProviders.find((entry) => entry.kind === "meituan");
  const availableTools = [...(tools.data ?? []), ...(meituanTools.data ?? [])];
  const visibleTools = availableTools.filter((tool) => activeToolIds.includes(tool.id));
  const saveEnabled = async (next: boolean) => {
    if (!canToggle || !allowed || busy) return;
    if (
      !next &&
      !(await requestConfirmDialog(
        t(
          "Pause Meituan integration on this environment? Saved settings and history are retained. WeChat, GitHub and local tasks are unaffected.",
        ),
        { variant: "destructive" },
      ))
    )
      return;
    setBusy(true);
    await update({ environmentId, input: { patch: { meituanIntegrationEnabled: next } } });
    setBusy(false);
    discovery.refresh();
    if (next) void refreshTools({ environmentId, input: {} });
  };
  const saveService = async (service: "code" | "issues" | "skills", value: boolean) => {
    if (
      !enabled ||
      busy ||
      !canToggle ||
      (service === "skills" ? !skillsAllowed || !skillQuery.data : !allowed)
    )
      return;
    setBusy(true);
    if (service === "skills") {
      const sources: ReadonlyArray<SkillSource> = skillSources.length
        ? skillSources
        : [
            {
              id: "meituan",
              label: "Meituan Skills",
              kind: "mtskills",
              enabled: false,
              executable: "mtskills",
              registry: "http://r.npm.sankuai.com",
            },
          ];
      await mutateSkills({
        environmentId,
        input: {
          type: "batch",
          operations: sources.map((source) => ({
            type: "source.save",
            source: { ...source, enabled: value },
          })),
        },
      });
      skillQuery.refresh();
      void refreshTools({ environmentId, input: {} });
    } else {
      await update({
        environmentId,
        input: {
          patch:
            service === "code"
              ? { meituanSourceControlEnabled: value }
              : { meituanRequirementsEnabled: value },
        },
      });
      discovery.refresh();
      void refreshTools({ environmentId, input: {} });
    }
    setBusy(false);
  };
  const toggles = {
    code: {
      checked: settings.meituanSourceControlEnabled,
      disabled: !canToggle || !enabled || !allowed || busy,
      onChange: (value: boolean) => void saveService("code", value),
    },
    issues: {
      checked: settings.meituanRequirementsEnabled,
      disabled: !canToggle || !enabled || !allowed || busy,
      onChange: (value: boolean) => void saveService("issues", value),
    },
    skills: {
      checked: skillSourceEnabled,
      disabled: !canToggle || !enabled || !skillsAllowed || busy || !skillQuery.data,
      onChange: (value: boolean) => void saveService("skills", value),
    },
  };
  const activeEnabled =
    active === "code"
      ? codeEnabled
      : active === "issues"
        ? issuesEnabled
        : active === "skills"
          ? skillsEnabled
          : enabled;
  const selected = (view?: MeituanSection) => {
    if (!view && hash) void navigate({ hash: "", replace: true });
    onSectionChange(view);
  };
  return (
    <div className="grid min-w-0 gap-6">
      {active ? (
        <div className="flex min-h-11 items-center gap-3">
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("Back to Meituan integration")}
            onClick={() => selected()}
          >
            <ArrowLeftIcon />
          </Button>
          <h2 className="min-w-0 flex-1 text-lg font-semibold">{t(titles[active])}</h2>
          {active !== "daxiang" && canToggle ? (
            <Switch
              aria-label={t("Enable {name}", { name: t(titles[active]) })}
              checked={toggles[active].checked}
              disabled={toggles[active].disabled}
              onCheckedChange={toggles[active].onChange}
            />
          ) : null}
        </div>
      ) : (
        <div className="flex min-h-20 items-center justify-between gap-4 border-b pb-5">
          <div>
            <Label htmlFor="meituan-integration">{t("Enable Meituan integration")}</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(enabled ? "Enabled" : "Disabled")}
            </p>
          </div>
          {canToggle ? (
            <Switch
              id="meituan-integration"
              checked={enabled}
              disabled={!allowed || busy}
              onCheckedChange={(value) => void saveEnabled(value)}
            />
          ) : (
            <span className="text-xs text-muted-foreground">{t("Server update required")}</span>
          )}
        </div>
      )}
      {!activeEnabled ? (
        <p role="status" className="flex items-start gap-2 text-sm text-muted-foreground">
          <PauseIcon className="mt-0.5 size-4 shrink-0" />
          {t(
            active && enabled
              ? "This service is disabled. Saved settings are retained."
              : active
                ? "Meituan integration is paused. Saved settings are read-only."
                : "Automatic Meituan activity is paused. Saved settings and history are retained.",
          )}
        </p>
      ) : null}
      {!active ? (
        <section>
          <h2 className="mb-2 text-xs text-muted-foreground">{t("Service configuration")}</h2>
          <ServiceRow
            icon={GitBranchIcon}
            title={t("Source control")}
            subtitle={`Meituan Code${settings.sourceControlHosts.meituan?.mis ? ` · ${settings.sourceControlHosts.meituan.mis}` : ""}`}
            status={t(
              !enabled
                ? "Paused"
                : !codeEnabled
                  ? "Disabled"
                  : item?.auth.status === "authenticated"
                    ? "Authenticated"
                    : "Not authenticated",
            )}
            onClick={() => selected("code")}
            {...(canToggle ? { toggle: toggles.code } : {})}
          />
          <ServiceRow
            icon={ClipboardListIcon}
            title={t("Requirements and delivery")}
            subtitle="MEP ONES · MCM"
            status={
              !enabled
                ? t("Paused")
                : !issuesEnabled
                  ? t("Disabled")
                  : t("{count} projects", {
                      count: associations.entries.length,
                    })
            }
            onClick={() => selected("issues")}
            {...(canToggle ? { toggle: toggles.issues } : {})}
          />
          <ServiceRow
            icon={MessagesSquareIcon}
            title={t("DaXiang")}
            subtitle={t("Application credentials and review messages")}
            status={t(
              !enabled
                ? "Paused"
                : settings.daxiang.clientId && settings.daxiang.clientSecret
                  ? "Configured"
                  : "Not configured",
            )}
            onClick={() => selected("daxiang")}
          />
          <ServiceRow
            icon={BookOpenIcon}
            title={t("Meituan Skills")}
            subtitle="mtskills"
            status={t(!enabled ? "Paused" : skillsEnabled ? "Enabled" : "Disabled")}
            onClick={() => selected("skills")}
            {...(canToggle ? { toggle: toggles.skills } : {})}
          />
        </section>
      ) : (
        <fieldset
          disabled={!activeEnabled || (active === "skills" ? !skillsAllowed : !allowed)}
          className="min-w-0"
        >
          {active === "code" ? (
            <div className="grid gap-6">
              <MeituanCodeSettings
                environmentId={environmentId}
                {...(item ? { item } : {})}
                onChanged={discovery.refresh}
              />
            </div>
          ) : active === "issues" ? (
            <MeituanProjectSources
              environmentId={environmentId}
              settings={settings}
              associations={associations}
            />
          ) : active === "daxiang" ? (
            <DaxiangSettings environmentId={environmentId} label={label} />
          ) : (
            <MeituanSkillSource
              environmentId={environmentId}
              disabled={!skillsEnabled || !skillsAllowed}
            />
          )}
        </fieldset>
      )}
      {visibleTools.length ? (
        <details>
          <summary className="cursor-pointer py-3 text-sm text-muted-foreground">
            {t("Command line tools")}
          </summary>
          {visibleTools.map((tool) => (
            <div
              key={tool.id}
              className="flex flex-wrap items-center justify-between gap-3 border-t py-4"
            >
              <div>
                <p className="text-sm">{tool.label}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {tool.id === "meituan" ? "code-cli" : tool.id}
                </p>
                <p className="text-xs text-muted-foreground">
                  {tool.version ?? t(tool.status === "missing" ? "Not installed" : "Unknown")}
                </p>
                <SourceControlToolStatus tool={tool} />
              </div>
              <SourceControlToolControls
                tool={tool}
                environmentId={environmentId}
                environmentLabel={label}
                busy={availableTools.some(
                  (entry) => entry.phase === "running" || entry.phase === "verifying",
                )}
              />
            </div>
          ))}
        </details>
      ) : null}
      {codeEnabled ? (
        <MeituanCodeAuthorizationObserver
          environmentId={environmentId}
          pending={item?.authorization?.status === "pending"}
          onChanged={discovery.refresh}
        />
      ) : null}
    </div>
  );
}

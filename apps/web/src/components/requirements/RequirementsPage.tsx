import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  EnvironmentId,
  ProjectId,
  parseBranchIssueUrl,
  type Issue,
  type IssueListResult,
} from "@t3tools/contracts";
import {
  ClipboardListIcon,
  LayoutGridIcon,
  ListIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
  CircleIcon,
  CircleCheckIcon,
  CircleDotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react";
import { useState } from "react";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useEnvironmentQuery } from "../../state/query";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarInset } from "../ui/sidebar";
import { IssueSelect } from "./IssueSelect";
import { IssueDetailPanel } from "./IssueDetailPanel";
import { IssueCreateDialog } from "./IssueCreateDialog";
import type { RequirementsSearch } from "../../routes/_chat.requirements";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { serverEnvironment } from "../../state/server";
import { Atom } from "effect/reactivity";
import { WorkItemsBoard } from "../work-items/WorkItemsPage";
import { DELIVERY_PROGRESS_LABELS } from "@t3tools/client-runtime/work-item";

const noSettings = Atom.make(null);

const COLUMNS = [
  { key: "todo", label: "To do", Icon: CircleIcon },
  { key: "doing", label: "In progress", Icon: CircleDotIcon },
  { key: "done", label: "Done", Icon: CircleCheckIcon },
  { key: "other", label: "Other states", Icon: CircleIcon },
] as const;

export function RequirementsPage() {
  const t = useUiTranslation();
  const search = useSearch({ from: "/_chat/requirements" });
  const navigate = useNavigate({ from: "/requirements" });
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const allProjects = useProjects();
  const environmentId = search.environmentId ?? primary;
  const provider = search.provider ?? "meituan";
  const assignee = search.assignee ?? "me";
  const narrow = useMediaQuery("(max-width: 767px)");
  const view = search.view ?? (narrow ? "list" : "board");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [doneCollapsed, setDoneCollapsed] = useState(true);
  const projects = allProjects.filter(
    (project) =>
      project.environmentId === environmentId &&
      !project.isScratch &&
      project.title !== "No project",
  );
  const settings = useAtomValue(
    environmentId ? serverEnvironment.settingsValueAtom(environmentId) : noSettings,
  );
  const config = useAtomValue(
    environmentId ? serverEnvironment.configValueAtom(environmentId) : noSettings,
  );
  const allowed = useAtomValue(sourceControlEnvironment.createIssue.permissionAtom(environmentId));
  const tracking = useEnvironmentQuery(
    environmentId && config?.workItemDelivery === true
      ? serverEnvironment.workItemsLive({
          environmentId,
          input: { ...(search.projectId ? { projectId: search.projectId } : {}), limit: 100 },
        })
      : null,
  );
  const tracked = new Map(
    (tracking.data?.items ?? [])
      .filter((item) => item.issue)
      .map((item) => [item.issue!.url, item]),
  );
  const query = useEnvironmentQuery(
    environmentId && !search.local
      ? sourceControlEnvironment.issues({
          environmentId,
          input: {
            provider,
            assignee,
            query: search.q ?? "",
            page,
            ...(search.projectId ? { projectId: search.projectId } : {}),
          },
        })
      : null,
  );
  const createProjects = projects.filter(
    (project) =>
      provider === "github" ||
      settings?.issueProjectSources[project.id]?.some((source) => source.provider === provider) ||
      query.data?.groups.some((group) => group.projectIds.includes(project.id)),
  );
  const peopleProjectId = search.projectId ?? query.data?.groups[0]?.projectIds[0];
  const peopleScope = query.data?.groups.find((group) =>
    group.projectIds.includes(peopleProjectId!),
  )?.source.scope;
  const people = useEnvironmentQuery(
    environmentId && peopleProjectId
      ? sourceControlEnvironment.issuePeople({
          environmentId,
          input: {
            projectId: peopleProjectId,
            provider,
            query: "",
            ...(peopleScope ? { scope: peopleScope } : {}),
          },
        })
      : null,
  );
  const [pages, setPages] = useState<{
    key: string;
    data: Array<typeof IssueListResult.Type>;
    last: typeof query.data;
  }>({ key: "", data: [], last: null });
  const key = [environmentId, provider, assignee, search.projectId, search.q].join("\n");
  if (pages.key !== key) {
    setPages({ key, data: [], last: null });
    if (page !== 1) setPage(1);
  } else if (query.data && pages.last !== query.data)
    setPages({ key, data: [...pages.data.slice(0, page - 1), query.data], last: query.data });
  const shownPages = pages.key === key ? pages.data : [];
  const rows = new Map<string, { issue: Issue; projectId: ProjectId; scope: string }>();
  for (const data of shownPages)
    for (const group of data.groups)
      for (const issue of group.issues) {
        const projectId = group.projectIds[0];
        if (projectId)
          rows.set(`${group.source.host}/${group.source.scope}/${issue.id}`, {
            issue,
            projectId,
            scope: group.source.scope,
          });
      }
  const entries = [...rows.values()];
  const assigneeOptions = [
    ...new Map(
      [...(people.data ?? []), ...entries.flatMap(({ issue }) => issue.assignees)].map((person) => [
        person.value,
        person,
      ]),
    ).values(),
  ];
  const updateSearch = (patch: {
    [Key in keyof RequirementsSearch]?: RequirementsSearch[Key] | undefined;
  }) => {
    setPage(1);
    void navigate({
      search: (previous) => {
        const merged = { ...previous, ...patch };
        return Object.fromEntries(
          Object.entries(merged).filter(([, value]) => value !== undefined),
        ) as RequirementsSearch;
      },
    });
  };
  const selectedProject = projects.find((project) => project.id === search.issueProjectId);
  const open = (issue: Issue, projectId: ProjectId, scope?: string) => {
    const issueScope = scope ?? parseBranchIssueUrl(issue.url)?.repository;
    void navigate({
      search: (previous) => ({
        ...previous,
        issueId: issue.id,
        issueProjectId: projectId,
        ...(issueScope ? { issueScope } : {}),
      }),
    });
  };
  const close = () =>
    void navigate({
      search: (previous) => {
        const { issueId: _id, issueProjectId: _project, issueScope: _scope, ...rest } = previous;
        return rest;
      },
    });
  const visibleColumns = COLUMNS.filter(
    (column) => column.key !== "doing" || provider === "meituan",
  ).filter(
    (column) =>
      column.key !== "other" || entries.some(({ issue }) => issue.stateCategory === "other"),
  );
  return (
    <SidebarInset className="h-dvh overflow-hidden">
      <div className="relative flex h-full min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-5">
            <div className="flex min-w-0 items-center gap-3">
              <ClipboardListIcon className="size-5 shrink-0 text-muted-foreground" />
              <h1 className="truncate text-base font-semibold">{t("Requirements board")}</h1>
              {!search.local ? (
                <span className="text-xs text-muted-foreground">{entries.length}</span>
              ) : null}
            </div>
            <div className="flex items-center gap-1">
              {!search.local ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("Refresh issues")}
                        onClick={() => {
                          setPage(1);
                          setPages({ key, data: [], last: null });
                          query.refresh();
                        }}
                      />
                    }
                  >
                    <RefreshCwIcon />
                  </TooltipTrigger>
                  <TooltipPopup>{t("Refresh issues")}</TooltipPopup>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("Issue management")}
                      onClick={() => void navigate({ to: "/settings/requirements" })}
                    />
                  }
                >
                  <SettingsIcon />
                </TooltipTrigger>
                <TooltipPopup>{t("Issue management")}</TooltipPopup>
              </Tooltip>
              {!search.local ? (
                <Button
                  size="sm"
                  onClick={() => setCreating(true)}
                  disabled={!allowed || !environmentId || createProjects.length === 0}
                >
                  <PlusIcon />
                  {t("New issue")}
                </Button>
              ) : null}
            </div>
          </header>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-3">
            {environments.length > 1 ? (
              <div className="w-40">
                <IssueSelect
                  label={t("Environment")}
                  value={environmentId ?? ""}
                  options={environments.map((environment) => ({
                    value: environment.environmentId,
                    label: environment.label,
                  }))}
                  onChange={(value) =>
                    updateSearch({
                      environmentId: EnvironmentId.make(value),
                      projectId: undefined,
                      issueId: undefined,
                      issueProjectId: undefined,
                    })
                  }
                />
              </div>
            ) : null}
            <div className="w-36">
              <IssueSelect
                label={t("Issue source")}
                value={search.local ? "local" : provider}
                options={[
                  { value: "meituan", label: "MEP ONES" },
                  { value: "github", label: "GitHub Issues" },
                  { value: "local", label: t("Local work items") },
                ]}
                onChange={(value) =>
                  updateSearch({
                    provider: value === "github" ? "github" : "meituan",
                    local: value === "local" ? true : undefined,
                    projectId: undefined,
                    issueId: undefined,
                    issueProjectId: undefined,
                  })
                }
              />
            </div>
            {!search.local ? (
              <>
                <div className="w-44">
                  <IssueSelect
                    label={t("Project")}
                    value={search.projectId ?? "all"}
                    options={[
                      { value: "all", label: t("All projects") },
                      ...projects.map((project) => ({ value: project.id, label: project.title })),
                    ]}
                    onChange={(value) =>
                      updateSearch({
                        projectId: value === "all" ? undefined : ProjectId.make(value),
                      })
                    }
                  />
                </div>
                <div className="w-40">
                  <IssueSelect
                    label={t("Assignee")}
                    value={assignee}
                    options={[
                      { value: "me", label: t("Assigned to me") },
                      { value: "all", label: t("All assignees") },
                      { value: "unassigned", label: t("Unassigned") },
                      ...assigneeOptions.filter(
                        (person) => !["me", "all", "unassigned"].includes(person.value),
                      ),
                    ]}
                    onChange={(value) => updateSearch({ assignee: value })}
                  />
                </div>
                <form
                  className="min-w-40 flex-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    updateSearch({ q: String(data.get("query") ?? "") });
                  }}
                >
                  <Input
                    name="query"
                    key={search.q ?? ""}
                    defaultValue={search.q ?? ""}
                    placeholder={t("Search title or number")}
                    aria-label={t("Search title or number")}
                    size="sm"
                  />
                </form>
              </>
            ) : null}
          </div>
          {!search.local ? (
            <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-3">
              <span className="text-xs text-muted-foreground">
                {t("{count} loaded", { count: entries.length })}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => updateSearch({ assignee: "all", projectId: undefined, q: "" })}
                >
                  {t("Reset filters")}
                </Button>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant={view === "board" ? "secondary" : "ghost"}
                        onClick={() => updateSearch({ view: "board" })}
                        aria-label={t("Board view")}
                        aria-pressed={view === "board"}
                      />
                    }
                  >
                    <LayoutGridIcon />
                  </TooltipTrigger>
                  <TooltipPopup>{t("Board view")}</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant={view === "list" ? "secondary" : "ghost"}
                        onClick={() => updateSearch({ view: "list" })}
                        aria-label={t("List view")}
                        aria-pressed={view === "list"}
                      />
                    }
                  >
                    <ListIcon />
                  </TooltipTrigger>
                  <TooltipPopup>{t("List view")}</TooltipPopup>
                </Tooltip>
              </div>
            </div>
          ) : null}
          {search.local && environmentId ? (
            <WorkItemsBoard
              environmentId={environmentId}
              initialProjectId={search.projectId}
              localOnly
            />
          ) : (
            <div
              className={`flex min-h-0 flex-1 flex-col px-5 pb-6 ${view === "board" ? "overflow-hidden" : "overflow-auto"}`}
            >
              {query.error ? (
                <p role="alert" className="mb-3 text-sm text-destructive">
                  {query.error}
                </p>
              ) : null}
              {query.data?.failures.map((failure) => (
                <p role="alert" key={failure.projectId} className="mb-3 text-sm text-destructive">
                  {projects.find((project) => project.id === failure.projectId)?.title}:{" "}
                  {t(failure.reason)}
                </p>
              ))}
              {query.isPending && !entries.length ? (
                <p className="py-8 text-sm text-muted-foreground">{t("Loading...")}</p>
              ) : !entries.length ? (
                <div className="flex min-h-64 flex-col items-center justify-center gap-4">
                  <ClipboardListIcon className="size-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {t(
                      query.data?.groups.length
                        ? "No matching issues."
                        : "Connect an issue source to start.",
                    )}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void navigate({ to: "/settings/requirements" })}
                  >
                    <SettingsIcon />
                    {t("Issue management")}
                  </Button>
                </div>
              ) : view === "list" ? (
                <div className="divide-y divide-border">
                  <button
                    type="button"
                    className="flex items-center gap-2 py-3 text-sm"
                    aria-expanded={!doneCollapsed}
                    onClick={() => setDoneCollapsed(!doneCollapsed)}
                  >
                    {doneCollapsed ? (
                      <ChevronRightIcon className="size-4" />
                    ) : (
                      <ChevronDownIcon className="size-4" />
                    )}
                    {t("Done")} (
                    {entries.filter(({ issue }) => issue.stateCategory === "done").length})
                  </button>
                  {entries
                    .filter(({ issue }) => !doneCollapsed || issue.stateCategory !== "done")
                    .map(({ issue, projectId, scope }) => (
                      <button
                        type="button"
                        key={`${projectId}/${scope}/${issue.id}`}
                        onClick={() => open(issue, projectId, scope)}
                        className="grid w-full grid-cols-[4rem_minmax(0,1fr)_7rem] items-center gap-3 py-4 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <span className="text-xs text-muted-foreground">#{issue.id}</span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{issue.title}</span>
                          <span className="text-xs text-muted-foreground">
                            {projects.find((project) => project.id === projectId)?.title} ·{" "}
                            {issue.assignees.map((person) => person.label).join(", ") ||
                              t("Unassigned")}
                          </span>
                          {tracked.get(issue.url)?.deliverySummary ? (
                            <span className="block text-xs text-muted-foreground">
                              {t(
                                DELIVERY_PROGRESS_LABELS[
                                  tracked.get(issue.url)!.deliverySummary!.progress
                                ],
                              )}{" "}
                              · PR {tracked.get(issue.url)!.deliverySummary!.mergedPullRequests}/
                              {tracked.get(issue.url)!.deliverySummary!.requiredPullRequests}
                            </span>
                          ) : null}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {issue.state}
                        </span>
                      </button>
                    ))}
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto">
                  {visibleColumns.map(({ key: category, label, Icon }) => (
                    <section key={category} className="flex min-h-0 min-w-60 flex-1 flex-col">
                      <div className="mb-3 flex h-9 shrink-0 items-center gap-2 border-b border-border text-sm">
                        <Icon
                          className={`size-4 ${category === "done" ? "text-success" : category === "doing" ? "text-warning" : "text-muted-foreground"}`}
                        />
                        <h2 className="font-medium">
                          {category === "done" ? (
                            <button
                              type="button"
                              className="flex items-center gap-2"
                              aria-expanded={!doneCollapsed}
                              onClick={() => setDoneCollapsed(!doneCollapsed)}
                            >
                              {t(provider === "github" ? "Closed" : label)}
                              {doneCollapsed ? (
                                <ChevronRightIcon className="size-4" />
                              ) : (
                                <ChevronDownIcon className="size-4" />
                              )}
                            </button>
                          ) : (
                            t(
                              provider === "github"
                                ? category === "todo"
                                  ? "Open"
                                  : "Closed"
                                : label,
                            )
                          )}
                        </h2>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {entries.filter(({ issue }) => issue.stateCategory === category).length}
                        </span>
                      </div>
                      <div
                        className="min-h-0 space-y-3 overflow-y-auto"
                        hidden={category === "done" && doneCollapsed}
                      >
                        {entries
                          .filter(({ issue }) => issue.stateCategory === category)
                          .map(({ issue, projectId, scope }) => (
                            <button
                              type="button"
                              key={`${projectId}/${scope}/${issue.id}`}
                              onClick={() => open(issue, projectId, scope)}
                              className="flex w-full flex-col gap-3 rounded-md border border-border bg-card p-3 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                            >
                              <span className="flex w-full items-center justify-between gap-2 text-xs text-muted-foreground">
                                <span>#{issue.id}</span>
                                <span>{issue.priority}</span>
                              </span>
                              <span className="text-sm font-medium wrap-anywhere">
                                {issue.title}
                              </span>
                              {tracked.get(issue.url)?.deliverySummary ? (
                                <span className="text-xs text-muted-foreground">
                                  {t(
                                    DELIVERY_PROGRESS_LABELS[
                                      tracked.get(issue.url)!.deliverySummary!.progress
                                    ],
                                  )}{" "}
                                  · PR {tracked.get(issue.url)!.deliverySummary!.mergedPullRequests}
                                  /{tracked.get(issue.url)!.deliverySummary!.requiredPullRequests}
                                </span>
                              ) : null}
                              <span className="truncate text-xs text-muted-foreground">
                                {projects.find((project) => project.id === projectId)?.title}
                              </span>
                              <span className="flex w-full flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                                <span>{issue.state}</span>
                                <span>
                                  {issue.assignees.map((person) => person.label).join(", ") ||
                                    t("Unassigned")}
                                </span>
                              </span>
                            </button>
                          ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}
              {query.data?.groups.some((group) => group.hasMore) ? (
                <div className="flex shrink-0 justify-center py-5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage(page + 1)}
                    disabled={query.isPending}
                  >
                    {t("Load more")}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
        {environmentId && search.issueId && selectedProject ? (
          <IssueDetailPanel
            key={`${environmentId}/${provider}/${selectedProject.id}/${search.issueScope}/${search.issueId}`}
            environmentId={environmentId}
            target={{
              projectId: selectedProject.id,
              provider,
              ...(search.issueScope ? { scope: search.issueScope } : {}),
            }}
            id={search.issueId}
            cwd={selectedProject.workspaceRoot}
            close={close}
            changed={() => {
              setPage(1);
              setPages({ key, data: [], last: null });
              query.refresh();
            }}
          />
        ) : null}
        {creating && environmentId ? (
          <IssueCreateDialog
            environmentId={environmentId}
            provider={provider}
            projects={createProjects}
            {...(search.projectId ? { initialProjectId: search.projectId } : {})}
            close={() => setCreating(false)}
            created={(issue, projectId) => {
              setCreating(false);
              setPage(1);
              query.refresh();
              open(issue, projectId);
            }}
          />
        ) : null}
      </div>
    </SidebarInset>
  );
}

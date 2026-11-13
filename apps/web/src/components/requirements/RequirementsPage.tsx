import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  type ProjectId,
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
  ChevronDownIcon,
  ChevronRightIcon,
  SlidersHorizontalIcon,
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
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
} from "../ui/menu";
import { IssueDetailPanel } from "./IssueDetailPanel";
import { IssueCreateDialog } from "./IssueCreateDialog";
import type { RequirementsSearch } from "../../routes/_chat.requirements";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import * as Schema from "effect/Schema";
import { serverEnvironment } from "../../state/server";
import { Atom } from "effect/reactivity";
import { WorkItemsBoard } from "../work-items/WorkItemsPage";
import {
  DELIVERY_PROGRESS_LABELS,
  REQUIREMENT_GROUPS,
  requirementGroup,
} from "@t3tools/client-runtime/work-item";
import { ProjectTag } from "./ProjectTag";

const noSettings = Atom.make(null);

const CollapsedGroups = Schema.Array(Schema.String);

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
  const view = search.view ?? "list";
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useLocalStorage<ReadonlyArray<string>, ReadonlyArray<string>>(
    "requirements.collapsed",
    ["done"],
    CollapsedGroups,
  );
  const projects = allProjects.filter(
    (project) =>
      project.environmentId === environmentId &&
      !project.isScratch &&
      project.title !== "No project",
  );
  const settings = useAtomValue(
    environmentId ? serverEnvironment.settingsValueAtom(environmentId) : noSettings,
  );
  const allowed = useAtomValue(sourceControlEnvironment.createIssue.permissionAtom(environmentId));
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
  const tracked = useAtomValue(
    serverEnvironment.issueWorkItems(
      environmentId,
      entries.map(({ issue }) => issue.url),
    ),
  );
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
  const groups = REQUIREMENT_GROUPS.map((group) => ({
    ...group,
    entries: entries.filter(
      ({ issue }) =>
        requirementGroup(issue.stateCategory, tracked.get(issue.url)?.deliverySummary) ===
        group.key,
    ),
  })).filter((group) => group.entries.length > 0);
  const filterItems = (
    <>
      {environments.length > 1 ? (
        <MenuSub>
          <MenuSubTrigger>{t("Environment")}</MenuSubTrigger>
          <MenuSubPopup>
            {environments.map((environment) => (
              <MenuItem
                key={environment.environmentId}
                onClick={() =>
                  updateSearch({
                    environmentId: environment.environmentId,
                    projectId: undefined,
                    issueId: undefined,
                    issueProjectId: undefined,
                  })
                }
              >
                {environment.label}
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
      ) : null}
      <MenuSub>
        <MenuSubTrigger>{t("Issue source")}</MenuSubTrigger>
        <MenuSubPopup>
          {[
            { value: "meituan", label: "MEP ONES" },
            { value: "github", label: "GitHub Issues" },
            { value: "local", label: t("Local work items") },
          ].map((option) => (
            <MenuItem
              key={option.value}
              onClick={() =>
                updateSearch({
                  provider: option.value === "github" ? "github" : "meituan",
                  local: option.value === "local" ? true : undefined,
                  projectId: undefined,
                  issueId: undefined,
                  issueProjectId: undefined,
                })
              }
            >
              {option.label}
            </MenuItem>
          ))}
        </MenuSubPopup>
      </MenuSub>
      {!search.local ? (
        <>
          <MenuSub>
            <MenuSubTrigger>{t("Project")}</MenuSubTrigger>
            <MenuSubPopup>
              <MenuItem onClick={() => updateSearch({ projectId: undefined })}>
                {t("All projects")}
              </MenuItem>
              {projects.map((project) => (
                <MenuItem key={project.id} onClick={() => updateSearch({ projectId: project.id })}>
                  {project.title}
                </MenuItem>
              ))}
            </MenuSubPopup>
          </MenuSub>
          <MenuSub>
            <MenuSubTrigger>{t("Assignee")}</MenuSubTrigger>
            <MenuSubPopup>
              {[
                { value: "me", label: t("Assigned to me") },
                { value: "all", label: t("All assignees") },
                { value: "unassigned", label: t("Unassigned") },
                ...assigneeOptions.filter(
                  (person) => !["me", "all", "unassigned"].includes(person.value),
                ),
              ].map((person) => (
                <MenuItem
                  key={person.value}
                  onClick={() => updateSearch({ assignee: person.value })}
                >
                  {person.label}
                </MenuItem>
              ))}
            </MenuSubPopup>
          </MenuSub>
        </>
      ) : null}
    </>
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
          {!search.local ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-5 py-3">
              {!search.local ? (
                <form
                  className="min-w-0 flex-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    updateSearch({
                      q: String(new FormData(event.currentTarget).get("query") ?? ""),
                    });
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
              ) : (
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {t("Local work items")}
                </span>
              )}
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("Filters")}
                      title={t("Filters")}
                    />
                  }
                >
                  <SlidersHorizontalIcon />
                </MenuTrigger>
                <MenuPopup align="end">{filterItems}</MenuPopup>
              </Menu>
              {!search.local ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("View")}
                        title={t("View")}
                      />
                    }
                  >
                    {view === "list" ? <ListIcon /> : <LayoutGridIcon />}
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem onClick={() => updateSearch({ view: "list" })}>
                      <ListIcon />
                      {t("List view")}
                    </MenuItem>
                    <MenuItem onClick={() => updateSearch({ view: "board" })}>
                      <LayoutGridIcon />
                      {t("Board view")}
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              ) : null}
            </div>
          ) : null}
          {!search.local ? (
            <div className="flex flex-wrap items-center gap-2 px-5 py-2 text-xs text-muted-foreground">
              <span>{provider === "github" ? "GitHub Issues" : "MEP ONES"}</span>
              <span>·</span>
              <span>
                {projects.find((project) => project.id === search.projectId)?.title ??
                  t("All projects")}
              </span>
              <span>·</span>
              <span>
                {assigneeOptions.find((person) => person.value === assignee)?.label ??
                  t(
                    assignee === "me"
                      ? "Assigned to me"
                      : assignee === "all"
                        ? "All assignees"
                        : "Unassigned",
                  )}
              </span>
            </div>
          ) : null}
          {search.local && environmentId ? (
            <WorkItemsBoard
              key={environmentId}
              environmentId={environmentId}
              initialProjectId={search.projectId}
              localOnly
              filterItems={filterItems}
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
              ) : (
                <div
                  className={
                    view === "board"
                      ? "grid min-h-0 flex-1 auto-cols-[minmax(260px,1fr)] grid-flow-col gap-5 overflow-auto"
                      : "space-y-4"
                  }
                >
                  {groups.map((group) => {
                    const folded = collapsed.includes(group.key);
                    return (
                      <section key={group.key} className="min-w-0">
                        <button
                          type="button"
                          className="flex min-h-11 w-full items-center gap-2 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          aria-expanded={!folded}
                          onClick={() =>
                            setCollapsed((previous) =>
                              folded
                                ? previous.filter((key) => key !== group.key)
                                : [...previous, group.key],
                            )
                          }
                        >
                          {folded ? (
                            <ChevronRightIcon className="size-3.5 text-muted-foreground" />
                          ) : (
                            <ChevronDownIcon className="size-3.5 text-muted-foreground" />
                          )}
                          <span className={group.key === "attention" ? "text-destructive" : ""}>
                            {t(group.label)}
                          </span>
                          <span className="font-normal text-muted-foreground tabular-nums">
                            {group.entries.length}
                          </span>
                        </button>
                        <div
                          hidden={folded}
                          className={view === "board" ? "space-y-2" : "divide-y divide-border/50"}
                        >
                          {group.entries.map(({ issue, projectId, scope }) => {
                            const summary = tracked.get(issue.url)?.deliverySummary;
                            const selected =
                              search.issueId === issue.id &&
                              search.issueProjectId === projectId &&
                              (!search.issueScope || search.issueScope === scope);
                            return (
                              <button
                                type="button"
                                key={issue.url}
                                aria-current={selected ? "true" : undefined}
                                onClick={() => open(issue, projectId, scope)}
                                className={
                                  "flex w-full min-w-0 flex-col gap-2 rounded-md px-3 py-3 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring " +
                                  (selected ? "bg-accent " : "") +
                                  (view === "board" ? "border border-border/70 bg-card" : "")
                                }
                              >
                                <span className="flex w-full items-start gap-3">
                                  <span className="min-w-0 flex-1 text-sm font-medium wrap-anywhere">
                                    {issue.title}
                                  </span>
                                  {issue.priority ? (
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                      {issue.priority}
                                    </span>
                                  ) : null}
                                </span>
                                <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                                  <ProjectTag
                                    title={
                                      projects.find((project) => project.id === projectId)?.title ??
                                      projectId
                                    }
                                  />
                                  <span>#{issue.id}</span>
                                  <span className="min-w-0 truncate">
                                    {issue.assignees.map((person) => person.label).join(", ") ||
                                      t("Unassigned")}
                                  </span>
                                  <span className="ml-auto flex items-center gap-2">
                                    {summary && summary.requiredPullRequests > 0 ? (
                                      <span className="inline-flex items-center gap-1 tabular-nums">
                                        <PullRequestGlyph.pullRequest className="size-3.5" />
                                        {summary.mergedPullRequests}/{summary.requiredPullRequests}
                                      </span>
                                    ) : null}
                                    <span
                                      className={
                                        group.key === "attention"
                                          ? "text-destructive"
                                          : group.key === "done"
                                            ? "text-success"
                                            : ""
                                      }
                                    >
                                      {summary
                                        ? t(
                                            summary.synced &&
                                              summary.progress === "delivery_complete"
                                              ? "Completed"
                                              : DELIVERY_PROGRESS_LABELS[summary.progress],
                                          )
                                        : issue.state}
                                    </span>
                                  </span>
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
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
            projectTitle={selectedProject.title}
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
            projects={projects}
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

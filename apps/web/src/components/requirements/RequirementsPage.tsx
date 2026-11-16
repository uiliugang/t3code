import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  parseBranchIssueUrl,
  type IssueProvider,
  type ProjectId,
  type EnvironmentId,
  type WorkItemCommandInput,
} from "@t3tools/contracts";
import {
  createRequirementOverviewAtoms,
  createRequirementPermissionAtoms,
  RequirementOverviewKey,
  type RequirementPagination,
  type EnvironmentRequirementEntry,
} from "@t3tools/client-runtime/state/requirement-board";
import {
  REQUIREMENT_GROUPS,
  DELIVERY_PROGRESS_LABELS,
  type RequirementSource,
  prepareWorkItemCommandRetry,
} from "@t3tools/client-runtime/work-item";
import {
  ClipboardListIcon,
  AlertTriangleIcon,
  ServerIcon,
  RefreshCwIcon,
  SettingsIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SlidersHorizontalIcon,
  ListIcon,
  LayoutGridIcon,
} from "lucide-react";
import { useContext, useRef, useState } from "react";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import * as Schema from "effect/Schema";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuCheckboxItem,
} from "../ui/menu";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { WorkItemEditor, WorkItemDetailPanel } from "../work-items/WorkItemsPage";
import { IssueDetailPanel } from "./IssueDetailPanel";
import { IssueCreateDialog } from "./IssueCreateDialog";
import { Popover, PopoverTrigger, PopoverPopup, PopoverTitle } from "../ui/popover";
import { RequirementCreateMenu, RequirementScanMenu } from "./RequirementBoardActions";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { ProjectTag } from "./ProjectTag";
import type { RequirementsSearch } from "../../routes/_chat.requirements";

const boardAtoms = createRequirementOverviewAtoms({
  issues: sourceControlEnvironment.issues,
  workItemsLive: serverEnvironment.workItemsLive,
  config: serverEnvironment.configValueAtom,
  tracked: serverEnvironment.issueWorkItems,
});
const permissionAtoms = createRequirementPermissionAtoms({
  createIssue: sourceControlEnvironment.createIssue.permissionAtom,
  mutateWorkItem: serverEnvironment.mutateWorkItem.permissionAtom,
  discoverWorkItems: serverEnvironment.discoverWorkItems.permissionAtom,
});
const CollapsedGroups = Schema.Array(Schema.String);
type SearchPatch = { [Key in keyof RequirementsSearch]?: RequirementsSearch[Key] | undefined };

export function RequirementsPage() {
  const t = useUiTranslation();
  const search = useSearch({ from: "/_chat/requirements" });
  const navigate = useNavigate({ from: "/requirements" });
  const primary = usePrimaryEnvironmentId();
  const environmentId = search.environmentId ?? primary;
  return environmentId ? (
    <SidebarInset className="h-dvh overflow-hidden">
      <RequirementBoard
        environmentId={environmentId}
        search={search}
        updateSearch={(patch) => {
          void navigate({
            search: (previous) =>
              Object.fromEntries(
                Object.entries({ ...previous, ...patch }).filter(
                  ([, value]) => value !== undefined,
                ),
              ) as RequirementsSearch,
          });
        }}
      />
    </SidebarInset>
  ) : (
    <SidebarInset>
      <p className="p-5 text-sm text-muted-foreground">
        {t("Connect an environment and add a project to use the task board.")}
      </p>
    </SidebarInset>
  );
}

export function RequirementBoard({
  environmentId: fallbackEnvironmentId,
  search,
  updateSearch,
  compact = false,
}: {
  environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
  search: RequirementsSearch;
  updateSearch: (patch: SearchPatch) => void;
  compact?: boolean;
}) {
  const t = useUiTranslation();
  const navigate = useNavigate();
  const registry = useContext(RegistryContext);
  const { environments } = useEnvironments();
  const onlineEnvironments = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const filterEnvironmentId = compact ? fallbackEnvironmentId : search.environmentId;
  const visibleEnvironments = onlineEnvironments.filter(
    (environment) => !filterEnvironmentId || environment.environmentId === filterEnvironmentId,
  );
  const [creatingEnvironmentId, setCreatingEnvironmentId] = useState<EnvironmentId | null>(null);
  const detailEnvironmentId =
    search.detailEnvironmentId ?? filterEnvironmentId ?? fallbackEnvironmentId;
  const environmentId = creatingEnvironmentId ?? detailEnvironmentId;
  const allProjects = useProjects().filter(
    (project) => !project.isScratch && project.archivedAt === null,
  );
  const projects = allProjects.filter((project) =>
    visibleEnvironments.some((environment) => environment.environmentId === project.environmentId),
  );
  const actionProjects = allProjects.filter((project) => project.environmentId === environmentId);
  const environmentLabel = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;
  const source: RequirementSource =
    search.source ?? (search.local ? "local" : (search.provider ?? "all"));
  const assignee = search.assignee ?? "me";
  const view = search.view ?? "list";
  const archived = search.archived ?? false;
  const [pagination, setPagination] = useState<{ key: string; pages: RequirementPagination }>({
    key: "",
    pages: {},
  });
  const environmentIds = visibleEnvironments.map((environment) => environment.environmentId);
  const permissions = useAtomValue(permissionAtoms(environmentIds));
  const filterKey = JSON.stringify([
    environmentIds,
    source,
    assignee,
    search.projectId,
    search.q,
    archived,
  ]);
  if (pagination.key !== filterKey) setPagination({ key: filterKey, pages: {} });
  const data = useAtomValue(
    boardAtoms(
      new RequirementOverviewKey({
        environmentIds,
        source,
        assignee,
        projectId: search.projectId ?? null,
        query: search.q ?? "",
        archived,
        pagination: pagination.key === filterKey ? pagination.pages : {},
      }),
    ),
  );
  const entries = data.entries;
  const errors = [
    ...data.errors.map((error) => `${environmentLabel(error.environmentId)}: ${error.message}`),
    ...data.failures.map(
      (failure) =>
        `${environmentLabel(failure.environmentId)} · ${allProjects.find((project) => project.environmentId === failure.environmentId && project.id === failure.projectId)?.title ?? failure.projectId}: ${t(failure.reason)}`,
    ),
  ];
  const [collapsed, setCollapsed] = useLocalStorage<ReadonlyArray<string>, ReadonlyArray<string>>(
    "requirements.collapsed",
    ["done"],
    CollapsedGroups,
  );
  const [creatingIssue, setCreatingIssue] = useState<IssueProvider | null>(null);
  const [creatingLocal, setCreatingLocal] = useState<ProjectId | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const retries = useRef(new Map<string, import("@t3tools/contracts").CommandId>());
  const mutate = useAtomCommand(serverEnvironment.mutateWorkItem, { reportFailure: false });
  const discover = useAtomCommand(serverEnvironment.discoverWorkItems);
  const [candidate, setCandidate] = useState<(typeof data.candidates)[number] | null>(null);
  const canCreateLocal = useAtomValue(
    serverEnvironment.mutateWorkItem.permissionAtom(environmentId),
  );
  const refresh = () => {
    for (const atom of data.atoms) registry.refresh(atom);
  };
  const close = () =>
    updateSearch({
      detailEnvironmentId: undefined,
      issueId: undefined,
      issueProjectId: undefined,
      issueScope: undefined,
      issueProvider: undefined,
      workItemId: undefined,
    });
  const open = (entry: EnvironmentRequirementEntry) => {
    if (entry.kind === "local")
      updateSearch({
        detailEnvironmentId: entry.environmentId,
        issueId: undefined,
        issueProjectId: undefined,
        issueScope: undefined,
        workItemId: entry.item.id,
      });
    else
      updateSearch({
        detailEnvironmentId: entry.environmentId,
        workItemId: undefined,
        issueId: entry.issue.id,
        issueProjectId: entry.projectId,
        issueScope: entry.scope,
        issueProvider: entry.provider,
      });
  };
  const run = async (input: WorkItemCommandInput, intent?: string) => {
    if (pending.current || !canCreateLocal) return false;
    pending.current = true;
    setBusy(true);
    const request = prepareWorkItemCommandRetry(input, retries.current, intent);
    const result = await mutate({ environmentId, input: request.input }).finally(() => {
      pending.current = false;
      setBusy(false);
    });
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result))
        toastManager.add({
          type: "error",
          title: t("Could not create task"),
          description: String(squashAtomCommandFailure(result)),
        });
      return false;
    }
    retries.current.delete(request.key);
    updateSearch({
      source: "all",
      provider: undefined,
      local: undefined,
      archived: false,
      q: undefined,
      detailEnvironmentId: environmentId,
      workItemId: result.value.item.id,
      issueId: undefined,
    });
    return true;
  };
  const selectedProject = allProjects.find(
    (project) =>
      project.environmentId === detailEnvironmentId && project.id === search.issueProjectId,
  );
  const selected = Boolean(search.workItemId || search.issueId);
  const assigneeOptions = [
    ...new Map(
      data.issuePages
        .flatMap((page) =>
          page.groups.flatMap((group) => group.issues.flatMap((issue) => issue.assignees)),
        )
        .map((person) => [person.value, person]),
    ).values(),
  ];
  if (!assigneeOptions.some((person) => person.value === assignee))
    assigneeOptions.push({ value: assignee, label: assignee });
  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <div className="relative flex h-full min-h-0 flex-1 overflow-hidden">
        <div
          className={`${selected ? (compact ? "hidden" : "hidden md:flex") : "flex"} min-h-0 min-w-0 flex-1 flex-col`}
        >
          <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-5">
            <div className="flex min-w-0 items-center gap-3">
              <ClipboardListIcon className="size-5 shrink-0 text-muted-foreground" />
              <h1 className="truncate text-base font-semibold">{t("Requirements board")}</h1>
              {errors.length ? (
                <Popover>
                  <PopoverTrigger
                    render={
                      <Button size="icon-sm" variant="ghost" aria-label={t("View loading errors")}>
                        <AlertTriangleIcon className="text-destructive" />
                      </Button>
                    }
                  />
                  <PopoverPopup align="start" width="md">
                    <div className="space-y-3">
                      <PopoverTitle>{t("Some requirements could not be loaded")}</PopoverTitle>
                      {errors.map((error) => (
                        <p key={error} className="text-sm text-destructive wrap-anywhere">
                          {error}
                        </p>
                      ))}
                      <Button size="sm" variant="outline" onClick={refresh}>
                        <RefreshCwIcon />
                        {t("Retry")}
                      </Button>
                    </div>
                  </PopoverPopup>
                </Popover>
              ) : null}
              <span className="text-xs text-muted-foreground">{entries.length}</span>
            </div>
            <RequirementCreateMenu
              environments={visibleEnvironments}
              {...(search.projectId ? { projectId: search.projectId } : {})}
              createIssue={(id, provider) => {
                setCreatingEnvironmentId(id);
                setCreatingIssue(provider);
              }}
              createLocal={(id, projectId) => {
                setCreatingEnvironmentId(id);
                setCandidate(null);
                setCreatingLocal(projectId);
              }}
            />
          </header>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-5 py-3">
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={compact}
                    aria-label={t("Environment")}
                  >
                    <ServerIcon />
                    <span className="max-w-40 truncate">
                      {filterEnvironmentId
                        ? environmentLabel(filterEnvironmentId)
                        : t("All environments")}
                    </span>
                    <ChevronDownIcon />
                  </Button>
                }
              />
              <MenuPopup align="start">
                {[
                  { environmentId: undefined, label: t("All environments") },
                  ...onlineEnvironments,
                ].map((environment) => (
                  <MenuCheckboxItem
                    key={environment.environmentId ?? "all"}
                    checked={filterEnvironmentId === environment.environmentId}
                    onCheckedChange={() =>
                      updateSearch({
                        environmentId: environment.environmentId,
                        projectId: undefined,
                        detailEnvironmentId: undefined,
                        issueId: undefined,
                        issueProjectId: undefined,
                        issueProvider: undefined,
                        issueScope: undefined,
                        workItemId: undefined,
                      })
                    }
                  >
                    {environment.label}
                  </MenuCheckboxItem>
                ))}
              </MenuPopup>
            </Menu>
            <div className="flex flex-wrap items-center gap-2">
              <RequirementScanMenu
                environments={visibleEnvironments}
                {...(search.projectId ? { projectId: search.projectId } : {})}
                refreshed={refresh}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void navigate({ to: "/settings/requirements" })}
              >
                <SettingsIcon />
                {t("Requirement settings")}
              </Button>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1 px-5 pt-3">
            <form
              className="min-w-0 flex-1"
              onSubmit={(event) => {
                event.preventDefault();
                updateSearch({ q: String(new FormData(event.currentTarget).get("query") ?? "") });
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
            <Menu>
              <MenuTrigger
                render={
                  <Button size="icon-sm" variant="ghost" aria-label={t("Filters")}>
                    <SlidersHorizontalIcon />
                  </Button>
                }
              />
              <MenuPopup align="end">
                <MenuSub>
                  <MenuSubTrigger>{t("Issue source")}</MenuSubTrigger>
                  <MenuSubPopup>
                    {(
                      [
                        { value: "all", label: t("All sources") },
                        { value: "meituan", label: "MEP ONES" },
                        { value: "github", label: "GitHub Issues" },
                        { value: "local", label: t("Local work items") },
                      ] as const
                    ).map((option) => (
                      <MenuCheckboxItem
                        key={option.value}
                        checked={source === option.value}
                        onCheckedChange={() =>
                          updateSearch({
                            source: option.value,
                            provider: undefined,
                            local: undefined,
                            assignee: undefined,
                            issueId: undefined,
                            workItemId: undefined,
                          })
                        }
                      >
                        {option.label}
                      </MenuCheckboxItem>
                    ))}
                  </MenuSubPopup>
                </MenuSub>
                {!compact ? (
                  <MenuSub>
                    <MenuSubTrigger>{t("Project")}</MenuSubTrigger>
                    <MenuSubPopup>
                      <MenuCheckboxItem
                        checked={!search.projectId}
                        onCheckedChange={() => updateSearch({ projectId: undefined })}
                      >
                        {t("All projects")}
                      </MenuCheckboxItem>
                      {projects.map((project) => (
                        <MenuCheckboxItem
                          key={`${project.environmentId}:${project.id}`}
                          checked={
                            search.projectId === project.id &&
                            (filterEnvironmentId ?? fallbackEnvironmentId) === project.environmentId
                          }
                          onCheckedChange={() =>
                            updateSearch({
                              environmentId: project.environmentId,
                              projectId: project.id,
                            })
                          }
                        >
                          {filterEnvironmentId
                            ? project.title
                            : `${environmentLabel(project.environmentId)} · ${project.title}`}
                        </MenuCheckboxItem>
                      ))}
                    </MenuSubPopup>
                  </MenuSub>
                ) : null}
                {source !== "local" ? (
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
                        <MenuCheckboxItem
                          key={person.value}
                          checked={assignee === person.value}
                          onCheckedChange={() => updateSearch({ assignee: person.value })}
                        >
                          {person.label}
                        </MenuCheckboxItem>
                      ))}
                    </MenuSubPopup>
                  </MenuSub>
                ) : null}
                <MenuCheckboxItem
                  checked={archived}
                  onCheckedChange={(checked) => updateSearch({ archived: checked })}
                >
                  {t("Show archived")}
                </MenuCheckboxItem>
              </MenuPopup>
            </Menu>
            <Menu>
              <MenuTrigger
                render={
                  <Button size="icon-sm" variant="ghost" aria-label={t("View")}>
                    {view === "list" ? <ListIcon /> : <LayoutGridIcon />}
                  </Button>
                }
              />
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
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("Refresh issues")}
              aria-busy={data.isPending}
              disabled={data.isPending}
              onClick={refresh}
            >
              <RefreshCwIcon />
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 px-5 py-2 text-xs text-muted-foreground">
            <span>
              {source === "all"
                ? t("All sources")
                : source === "local"
                  ? t("Local work items")
                  : source === "github"
                    ? "GitHub Issues"
                    : "MEP ONES"}
            </span>
            <span>·</span>
            <span>
              {projects.find((project) => project.id === search.projectId)?.title ??
                t("All projects")}
            </span>
            {archived ? <span>· {t("Show archived")}</span> : null}
            <span role="status">{data.isPending && entries.length ? t("Updating") : null}</span>
          </div>
          <div
            aria-busy={data.isPending}
            className={`flex min-h-0 flex-1 flex-col px-5 pb-6 ${view === "board" ? "overflow-hidden" : "overflow-auto"}`}
          >
            {data.isPending && !entries.length ? (
              <div role="status" aria-label={t("Loading...")} className="space-y-4 py-4">
                <span className="sr-only">{t("Loading...")}</span>
                {[0, 1, 2, 3].map((row) => (
                  <div
                    key={row}
                    aria-hidden="true"
                    className="space-y-3 border-b border-border/50 py-3"
                  >
                    <div className="h-4 w-2/3 rounded-sm bg-muted-foreground/15" />
                    <div className="h-3 w-1/3 rounded-sm bg-muted-foreground/15" />
                  </div>
                ))}
              </div>
            ) : !entries.length && errors.length ? (
              <div className="space-y-3 py-8">
                <p className="text-sm text-muted-foreground">
                  {t("Some requirements could not be loaded")}
                </p>
                <Button size="sm" variant="outline" onClick={refresh}>
                  <RefreshCwIcon />
                  {t("Retry")}
                </Button>
              </div>
            ) : !entries.length ? (
              <p className="py-8 text-sm text-muted-foreground">{t("No matching work items.")}</p>
            ) : (
              <div
                className={
                  view === "board"
                    ? "grid min-h-0 flex-1 auto-cols-[minmax(260px,1fr)] grid-flow-col gap-5 overflow-auto"
                    : "space-y-4"
                }
              >
                {REQUIREMENT_GROUPS.map((group) => {
                  const rows = entries.filter((entry) => entry.group === group.key);
                  if (!rows.length) return null;
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
                          {rows.length}
                        </span>
                      </button>
                      <div
                        hidden={folded}
                        className={view === "board" ? "space-y-2" : "divide-y divide-border/50"}
                      >
                        {rows.map((entry) => (
                          <button
                            type="button"
                            key={entry.key}
                            aria-current={
                              detailEnvironmentId === entry.environmentId &&
                              ((search.workItemId ===
                                (entry.kind === "local" ? entry.item.id : undefined) &&
                                entry.kind === "local") ||
                                (entry.kind === "issue" &&
                                  search.issueId === entry.issue.id &&
                                  search.issueProjectId === entry.projectId &&
                                  search.issueProvider === entry.provider))
                                ? "true"
                                : undefined
                            }
                            onClick={() => open(entry)}
                            className={
                              "flex w-full min-w-0 flex-col gap-2 rounded-md px-3 py-3 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring " +
                              (view === "board" ? "border border-border/70 bg-card" : "")
                            }
                          >
                            <span className="flex w-full items-start gap-3">
                              <span className="min-w-0 flex-1 text-sm font-medium wrap-anywhere">
                                {entry.title}
                              </span>
                              <span className="shrink-0 text-xs text-muted-foreground">
                                {entry.priority}
                              </span>
                            </span>
                            <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <span className="inline-flex max-w-48 items-center gap-1 rounded border border-border/70 px-1.5 py-0.5" />
                                  }
                                >
                                  <ServerIcon className="size-3 shrink-0" />
                                  <span className="truncate">
                                    {environmentLabel(entry.environmentId)}
                                  </span>
                                </TooltipTrigger>
                                <TooltipPopup>
                                  {t("Environment")}: {environmentLabel(entry.environmentId)}
                                </TooltipPopup>
                              </Tooltip>
                              <ProjectTag
                                title={
                                  projects.find(
                                    (project) =>
                                      project.id === entry.projectId &&
                                      project.environmentId === entry.environmentId,
                                  )?.title ?? entry.projectId
                                }
                              />
                              <span>
                                {entry.kind === "local"
                                  ? t("Local work item")
                                  : `${entry.provider === "github" ? "GitHub" : "ONES"} #${entry.issue.id}`}
                              </span>
                              {entry.kind === "local" ? (
                                <span>
                                  {entry.item.activeExecutionCount} {t("Active agents")}
                                </span>
                              ) : (
                                <span className="min-w-0 truncate">
                                  {entry.issue.assignees.map((person) => person.label).join(", ") ||
                                    t("Unassigned")}
                                </span>
                              )}
                              <span className="ml-auto flex items-center gap-2">
                                {entry.summary && entry.summary.requiredPullRequests > 0 ? (
                                  <span className="inline-flex items-center gap-1 tabular-nums">
                                    <PullRequestGlyph.pullRequest className="size-3.5" />
                                    {entry.summary.mergedPullRequests}/
                                    {entry.summary.requiredPullRequests}
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
                                  {entry.summary
                                    ? t(
                                        entry.summary.synced &&
                                          entry.summary.progress === "delivery_complete"
                                          ? "Completed"
                                          : DELIVERY_PROGRESS_LABELS[entry.summary.progress],
                                      )
                                    : entry.kind === "local"
                                      ? t(entry.state)
                                      : entry.state}
                                </span>
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
            {data.candidates.length && (source === "all" || source === "local") ? (
              <section className="space-y-3 border-t border-border/60 py-4">
                <h2 className="text-sm font-medium">{t("Discovered tasks")}</h2>
                {data.candidates.map((item) => (
                  <div key={`${item.environmentId}:${item.id}`} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{item.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {environmentLabel(item.environmentId)}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!permissions.get(item.environmentId)?.mutateWorkItem || busy}
                      onClick={() => {
                        setCreatingEnvironmentId(item.environmentId);
                        setCandidate(item);
                        setCreatingLocal(item.projectId);
                      }}
                    >
                      {t("Add task")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={
                        !permissions.get(item.environmentId)?.discoverWorkItems ||
                        busy ||
                        registry.get(serverEnvironment.configValueAtom(item.environmentId))
                          ?.workItemDiscovery !== true
                      }
                      onClick={async () => {
                        await discover({
                          environmentId: item.environmentId,
                          input: { projectId: item.projectId, dismissThreadId: item.id },
                        });
                        refresh();
                      }}
                    >
                      {t("Ignore")}
                    </Button>
                  </div>
                ))}
              </section>
            ) : null}
            {data.hasMore ? (
              <div className="flex shrink-0 justify-center py-5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={data.isPending}
                  onClick={() => setPagination({ key: filterKey, pages: data.nextPagination })}
                >
                  {t("Load more")}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
        {search.workItemId ? (
          <WorkItemDetailPanel
            key={`${detailEnvironmentId}/${search.workItemId}`}
            environmentId={detailEnvironmentId}
            id={search.workItemId}
            close={close}
          />
        ) : selectedProject && search.issueId ? (
          <IssueDetailPanel
            key={`${detailEnvironmentId}/${search.issueProvider}/${selectedProject.id}/${search.issueScope}/${search.issueId}`}
            environmentId={detailEnvironmentId}
            target={{
              projectId: selectedProject.id,
              provider: search.issueProvider ?? search.provider ?? "meituan",
              ...(search.issueScope ? { scope: search.issueScope } : {}),
            }}
            id={search.issueId}
            cwd={selectedProject.workspaceRoot}
            projectTitle={selectedProject.title}
            close={close}
            changed={refresh}
          />
        ) : null}
        {creatingIssue ? (
          <IssueCreateDialog
            environmentId={environmentId}
            provider={creatingIssue}
            projects={actionProjects}
            {...(search.projectId ? { initialProjectId: search.projectId } : {})}
            close={() => {
              setCreatingIssue(null);
              setCreatingEnvironmentId(null);
            }}
            created={(issue, projectId) => {
              setCreatingIssue(null);
              setCreatingEnvironmentId(null);
              refresh();
              updateSearch({
                detailEnvironmentId: environmentId,
                workItemId: undefined,
                issueId: issue.id,
                issueProjectId: projectId,
                issueProvider: creatingIssue,
                issueScope: parseBranchIssueUrl(issue.url)?.repository,
                source: "all",
                provider: undefined,
                local: undefined,
                archived: false,
                q: undefined,
              });
            }}
          />
        ) : null}
        {creatingLocal ? (
          <WorkItemEditor
            environmentId={environmentId}
            projectId={creatingLocal}
            {...(candidate ? { candidate } : {})}
            busy={busy}
            run={run}
            close={() => {
              setCreatingLocal(null);
              setCreatingEnvironmentId(null);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

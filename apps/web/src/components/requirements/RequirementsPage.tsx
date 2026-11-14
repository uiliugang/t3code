import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  parseBranchIssueUrl,
  type IssueProvider,
  type ProjectId,
  type WorkItemListInput,
  type WorkItemCommandInput,
} from "@t3tools/contracts";
import {
  createRequirementBoardAtoms,
  RequirementBoardKey,
} from "@t3tools/client-runtime/state/requirement-board";
import {
  mergeRequirementEntries,
  REQUIREMENT_GROUPS,
  DELIVERY_PROGRESS_LABELS,
  type RequirementEntry,
  type RequirementSource,
  prepareWorkItemCommandRetry,
} from "@t3tools/client-runtime/work-item";
import {
  ClipboardListIcon,
  PlusIcon,
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
import { ProjectTag } from "./ProjectTag";
import type { RequirementsSearch } from "../../routes/_chat.requirements";

const boardAtoms = createRequirementBoardAtoms({
  issues: sourceControlEnvironment.issues,
  workItemsLive: serverEnvironment.workItemsLive,
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
        key={environmentId}
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
  environmentId,
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
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId && !project.isScratch && project.archivedAt === null,
  );
  const source: RequirementSource =
    search.source ?? (search.local ? "local" : (search.provider ?? "all"));
  const assignee = search.assignee ?? "me";
  const view = search.view ?? "list";
  const archived = search.archived ?? false;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [pagination, setPagination] = useState<{
    key: string;
    page: number;
    cursors: ReadonlyArray<WorkItemListInput["cursor"]>;
  }>({ key: "", page: 1, cursors: [undefined] });
  const filterKey = JSON.stringify([
    environmentId,
    source,
    assignee,
    search.projectId,
    search.q,
    archived,
  ]);
  if (pagination.key !== filterKey)
    setPagination({ key: filterKey, page: 1, cursors: [undefined] });
  const data = useAtomValue(
    boardAtoms(
      new RequirementBoardKey({
        environmentId,
        source,
        assignee,
        projectId: search.projectId ?? null,
        query: search.q ?? "",
        archived,
        localSupported: config?.workItems === true,
        page: pagination.key === filterKey ? pagination.page : 1,
        cursors: pagination.key === filterKey ? pagination.cursors : [undefined],
      }),
    ),
  );
  const tracked = useAtomValue(
    serverEnvironment.issueWorkItems(
      environmentId,
      data.issuePages.flatMap((page) =>
        page.groups.flatMap((group) => group.issues.map((issue) => issue.url)),
      ),
    ),
  );
  const entries = mergeRequirementEntries(data.issuePages, data.items, tracked, {
    source,
    query: search.q ?? "",
    archived,
  });
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
  const canDiscover = useAtomValue(
    serverEnvironment.discoverWorkItems.permissionAtom(environmentId),
  );
  const [candidate, setCandidate] = useState<(typeof data.candidates)[number] | null>(null);
  const canCreateLocal = useAtomValue(
    serverEnvironment.mutateWorkItem.permissionAtom(environmentId),
  );
  const canCreateIssue = useAtomValue(
    sourceControlEnvironment.createIssue.permissionAtom(environmentId),
  );
  const refresh = () => {
    for (const atom of data.atoms) registry.refresh(atom);
  };
  const close = () =>
    updateSearch({
      issueId: undefined,
      issueProjectId: undefined,
      issueScope: undefined,
      issueProvider: undefined,
      workItemId: undefined,
    });
  const open = (entry: RequirementEntry) => {
    if (entry.kind === "local")
      updateSearch({
        issueId: undefined,
        issueProjectId: undefined,
        issueScope: undefined,
        workItemId: entry.item.id,
      });
    else
      updateSearch({
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
      workItemId: result.value.item.id,
      issueId: undefined,
    });
    return true;
  };
  const selectedProject = projects.find((project) => project.id === search.issueProjectId);
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
              <span className="text-xs text-muted-foreground">{entries.length}</span>
            </div>
            <Menu>
              <MenuTrigger
                render={
                  <Button size="sm">
                    <PlusIcon />
                    {t("New")}
                  </Button>
                }
              />
              <MenuPopup align="end">
                {(["meituan", "github"] as const).map((provider) => (
                  <MenuItem
                    key={provider}
                    disabled={!canCreateIssue || !projects.length}
                    onClick={() => setCreatingIssue(provider)}
                  >
                    {provider === "github" ? "GitHub Issue" : "MEP ONES"}
                  </MenuItem>
                ))}
                <MenuSub>
                  <MenuSubTrigger
                    disabled={!canCreateLocal || config?.workItems !== true || !projects.length}
                  >
                    {t("Local work item")}
                  </MenuSubTrigger>
                  <MenuSubPopup>
                    {projects.map((project) => (
                      <MenuItem
                        key={project.id}
                        onClick={() => {
                          setCandidate(null);
                          setCreatingLocal(project.id);
                        }}
                      >
                        {project.title}
                      </MenuItem>
                    ))}
                  </MenuSubPopup>
                </MenuSub>
              </MenuPopup>
            </Menu>
          </header>
          <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-5 py-3">
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
                {environments.length > 1 && !compact ? (
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
                              workItemId: undefined,
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
                      <MenuItem onClick={() => updateSearch({ projectId: undefined })}>
                        {t("All projects")}
                      </MenuItem>
                      {projects.map((project) => (
                        <MenuItem
                          key={project.id}
                          onClick={() => updateSearch({ projectId: project.id })}
                        >
                          {project.title}
                        </MenuItem>
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
                        <MenuItem
                          key={person.value}
                          onClick={() => updateSearch({ assignee: person.value })}
                        >
                          {person.label}
                        </MenuItem>
                      ))}
                    </MenuSubPopup>
                  </MenuSub>
                ) : null}
                <MenuItem
                  disabled={
                    !canDiscover || config?.workItemDiscovery !== true || !search.projectId || busy
                  }
                  onClick={async () => {
                    if (!search.projectId || pending.current) return;
                    pending.current = true;
                    setBusy(true);
                    await discover({
                      environmentId,
                      input: { projectId: search.projectId },
                    }).finally(() => {
                      pending.current = false;
                      setBusy(false);
                    });
                    refresh();
                  }}
                >
                  {t("Scan chats")}
                </MenuItem>
                <MenuCheckboxItem
                  checked={archived}
                  onCheckedChange={(checked) => updateSearch({ archived: checked })}
                >
                  {t("Show archived")}
                </MenuCheckboxItem>
                <MenuItem onClick={() => void navigate({ to: "/settings/requirements" })}>
                  <SettingsIcon />
                  {t("Issue management")}
                </MenuItem>
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
          </div>
          <div
            className={`flex min-h-0 flex-1 flex-col px-5 pb-6 ${view === "board" ? "overflow-hidden" : "overflow-auto"}`}
          >
            {[...new Set(data.errors)].map((error) => (
              <p key={error} role="alert" className="mb-3 text-sm text-destructive">
                {error}
              </p>
            ))}
            {data.issuePages
              .flatMap((page) => page.failures)
              .map((failure) => (
                <p
                  key={`${failure.projectId}:${failure.reason}`}
                  role="alert"
                  className="mb-3 text-sm text-destructive"
                >
                  {projects.find((project) => project.id === failure.projectId)?.title}:{" "}
                  {t(failure.reason)}
                </p>
              ))}
            {data.isPending && !entries.length ? (
              <p className="py-8 text-sm text-muted-foreground">{t("Loading...")}</p>
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
                              (search.workItemId ===
                                (entry.kind === "local" ? entry.item.id : undefined) &&
                                entry.kind === "local") ||
                              (entry.kind === "issue" &&
                                search.issueId === entry.issue.id &&
                                search.issueProjectId === entry.projectId &&
                                search.issueProvider === entry.provider)
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
                              <ProjectTag
                                title={
                                  projects.find((project) => project.id === entry.projectId)
                                    ?.title ?? entry.projectId
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
                  <div key={item.id} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canCreateLocal || busy}
                      onClick={() => {
                        setCandidate(item);
                        setCreatingLocal(item.projectId);
                      }}
                    >
                      {t("Add task")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!canDiscover || busy || config?.workItemDiscovery !== true}
                      onClick={async () => {
                        await discover({
                          environmentId,
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
            {data.moreIssues || data.nextCursor ? (
              <div className="flex shrink-0 justify-center py-5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={data.isPending}
                  onClick={() =>
                    setPagination((previous) => ({
                      ...previous,
                      page: data.moreIssues ? previous.page + 1 : previous.page,
                      cursors: data.nextCursor
                        ? [...previous.cursors, data.nextCursor]
                        : previous.cursors,
                    }))
                  }
                >
                  {t("Load more")}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
        {search.workItemId ? (
          <WorkItemDetailPanel environmentId={environmentId} id={search.workItemId} close={close} />
        ) : selectedProject && search.issueId ? (
          <IssueDetailPanel
            key={`${environmentId}/${search.issueProvider}/${selectedProject.id}/${search.issueScope}/${search.issueId}`}
            environmentId={environmentId}
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
            projects={projects}
            {...(search.projectId ? { initialProjectId: search.projectId } : {})}
            close={() => setCreatingIssue(null)}
            created={(issue, projectId) => {
              setCreatingIssue(null);
              refresh();
              updateSearch({
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
            close={() => setCreatingLocal(null)}
          />
        ) : null}
      </div>
    </div>
  );
}

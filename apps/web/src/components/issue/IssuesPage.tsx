import {
  continueIssuePage,
  groupIssues,
  holdIssuePages,
  issueCursorsForHost,
  issueFilterScopes,
  issueTrackerKey,
  type HeldIssuePage,
} from "@t3tools/client-runtime/issue-list";
import { issueTrackerDetailText } from "@t3tools/client-runtime/state/issue-trackers";
import { issueEntryKey } from "@t3tools/client-runtime/state/issues";
import type {
  EnvironmentId,
  IssueInvolvement,
  IssueListInput,
  IssueListSort,
  IssueListState,
  IssueTrackerSummary,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ArrowDownUpIcon,
  AtSignIcon,
  CalendarArrowDownIcon,
  CircleCheckIcon,
  ClockIcon,
  LayersIcon,
  PenLineIcon,
  Plug2Icon,
  UserCheckIcon,
  UsersIcon,
} from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { Fragment, useState, type ReactNode } from "react";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { IssueRow, type IssueRowTarget } from "~/components/issue/IssueRow";
import {
  issueListPreferences,
  readIssueListPreferences,
  writeIssueListPreferences,
  type IssueListPreferences,
} from "~/components/issue/issueListPreferences";
import { IssueGlyph, issueTrackerPresentation } from "~/components/issue/issuePresentation";
import { PullRequestListGhost } from "~/components/pullRequest/PullRequestGhosts";
import {
  PullRequestFilterOptionIcon,
  pullRequestProjectKey,
  PullRequestSearchInput,
  type PullRequestFilterOption,
} from "~/components/pullRequest/PullRequestListFilters";
import { m, type MessageResolver } from "~/i18n/messages";
import { resolveFilterOptions } from "../pullRequest/pullRequestListOptions";
import { IssueFiltersMenu } from "./IssueListFilterPickers";
import { issueFilterProjects, issueListTargets, issueProjectKeys } from "./issuesSearch.logic";
import { ISSUE_SAVED_VIEWS } from "./issueSavedViews";
import { SavedViewsMenu } from "~/components/SavedViewsMenu";
import { PullRequestCompactFilterMenu } from "../pullRequest/PullRequestCompactFilterMenu";
import { PullRequestsUnavailableState } from "~/components/pullRequest/PullRequestsUnavailableState";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import {
  selectActiveRightPanelSurface,
  useRightPanelStore,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { useAtomCommand } from "~/state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useProjects } from "~/state/entities";
import { useEnvironments, useIssuesSupported } from "~/state/environments";
import { issueEnvironment, useIssueList } from "~/state/issues";
import { useDebouncedValue } from "~/state/queries";
import {
  requirementSelection,
  type RequirementSearchPatch,
} from "../requirements/requirementPanelSearch";
import type { RequirementsSearch } from "../../routes/_chat.requirements";

export interface IssuesSearch extends IssueListPreferences {
  readonly selectedEnvironmentId?: EnvironmentId | undefined;
  readonly selectedProjectId?: ProjectId | undefined;
  /** Part of the panel tab's identity, so a link reopens the tab a row press opened. */
  readonly selectedHost?: string | undefined;
  readonly tracker?: string | undefined;
  readonly scope?: string | undefined;
  readonly key?: string | undefined;
}

const STATE_TABS = [
  { value: "open", label: msg("Open", { $context: "issue state" }), Icon: IssueGlyph.issue },
  { value: "closed", label: msg("Closed", { $context: "issue state" }), Icon: CircleCheckIcon },
  { value: "all", label: msg("All", { $context: "issue filter" }), Icon: LayersIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<IssueListState>>;

const INVOLVEMENT_TABS = [
  { value: "all", label: msg("Everyone", { $context: "issue filter" }), Icon: UsersIcon },
  { value: "assigned", label: msg("Assigned to me"), Icon: UserCheckIcon },
  { value: "authored", label: msg("Opened by me"), Icon: PenLineIcon },
  { value: "mentioned", label: msg("Mentioning me"), Icon: AtSignIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<IssueInvolvement>>;

const SORT_OPTIONS = [
  { value: "updated", label: msg("Recently updated"), Icon: ClockIcon },
  {
    value: "created",
    label: msg("Newest", { $context: "sort order" }),
    Icon: CalendarArrowDownIcon,
  },
] as const satisfies ReadonlyArray<PullRequestFilterOption<IssueListSort>>;

const PAGE_SIZE = 50;

function hostOptionsFor(
  trackers: ReadonlyArray<IssueTrackerSummary>,
  chosen: string | undefined,
  resolve: MessageResolver,
) {
  const hosts = new Map<string, IssueTrackerSummary>();
  const ordered = [...trackers].sort((a, b) =>
    issueTrackerKey(a).localeCompare(issueTrackerKey(b)),
  );
  for (const tracker of ordered) {
    const existing = hosts.get(tracker.host);
    if (existing === undefined || (!existing.configured && tracker.configured))
      hosts.set(tracker.host, tracker);
  }
  return [
    { value: "", label: resolve(msg("All", { $context: "issue filter" })), Icon: Plug2Icon },
    // A remembered host no project is on any more stays listed, so the filter can be taken off.
    ...(chosen !== undefined && !hosts.has(chosen)
      ? [{ value: chosen, label: chosen, Icon: Plug2Icon }]
      : []),
    ...[...hosts.values()].map((tracker) => ({
      value: tracker.host,
      label:
        hosts.size > 1 && issueTrackerPresentation(tracker.tracker).providerName === tracker.host
          ? tracker.host
          : `${issueTrackerPresentation(tracker.tracker).providerName} (${tracker.host})`,
      Icon: issueTrackerPresentation(tracker.tracker).Icon,
      ...(tracker.configured
        ? {}
        : {
            unavailable:
              tracker.detail === null
                ? resolve(msg("Unavailable"))
                : issueTrackerDetailText(tracker.detail, resolve),
          }),
    })),
  ];
}

function surfaceMatchesRow(
  surface: RightPanelSurface | null,
  row: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly tracker: string;
    readonly host: string;
    readonly scope: string;
    readonly key: string;
  },
  fallbackEnvironmentId: EnvironmentId,
) {
  if (!surface) return false;
  const surfaceEnvironmentId =
    ("environmentId" in surface
      ? (surface.environmentId as EnvironmentId | undefined)
      : undefined) ?? fallbackEnvironmentId;
  if (surfaceEnvironmentId !== row.environmentId) return false;
  if (surface.kind === "issue") {
    return (
      issueEntryKey({
        ...surface,
        host: surface.host ?? "",
        projectId: surface.projectId as ProjectId,
      }) === issueEntryKey(row)
    );
  }
  if (surface.kind === "requirement-issue") {
    return (
      surface.projectId === row.projectId &&
      surface.provider === row.tracker &&
      surface.issueId === row.key &&
      (surface.scope === undefined || surface.scope === row.scope) &&
      (surface.host === undefined || surface.host === row.host)
    );
  }
  return false;
}

export function TrackerIssuesView({
  search,
  updateSearch,
  panelRef,
  renderedSurface,
  fallbackEnvironmentId,
}: {
  search: RequirementsSearch;
  updateSearch: (patch: RequirementSearchPatch) => void;
  panelRef: ScopedThreadRef;
  renderedSurface: RightPanelSurface | null;
  fallbackEnvironmentId: EnvironmentId;
}) {
  const t = useUiTranslation();
  const gt = useGT();
  const resolve = useMessages();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const issuesSupported = useIssuesSupported();

  const savedDefaults = readIssueListPreferences();
  const who = search.who ?? savedDefaults.who;
  const status = search.status ?? savedDefaults.status;
  const hideProjects = search.hideProjects ?? savedDefaults.hideProjects;
  const host = search.host ?? savedDefaults.host;
  const labels = search.trackerLabels ?? savedDefaults.label;
  const assignee = search.trackerAssignee ?? savedDefaults.assignee;
  const order = search.order ?? savedDefaults.order;
  const queryText = search.trackerQuery ?? savedDefaults.q ?? "";

  const currentPreferences = issueListPreferences({
    who,
    status,
    hideProjects,
    host,
    q: queryText || undefined,
    label: labels,
    assignee,
    order,
  });

  const capableEnvironments = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.issues === true,
  );
  const environmentLabels = new Map(environments.map((e) => [e.environmentId, e.label] as const));
  const filterProjects = issueFilterProjects(
    projects.filter((project) =>
      capableEnvironments.some((e) => e.environmentId === project.environmentId),
    ),
    environmentLabels,
  );
  const hiddenProjects = issueProjectKeys(hideProjects);

  const debouncedQuery = useDebouncedValue(queryText, 300);
  const listInput: IssueListInput = {
    state: status,
    involvement: who,
    limit: PAGE_SIZE,
    ...(host ? { host } : {}),
    ...(debouncedQuery ? { query: debouncedQuery } : {}),
    ...(labels?.length ? { labels } : {}),
    ...(assignee ? { assignee } : {}),
    ...(order ? { sort: order } : {}),
  };
  const everyProjectHidden =
    filterProjects.length > 0 &&
    filterProjects.every((project) => hiddenProjects.has(pullRequestProjectKey(project)));
  const targets = everyProjectHidden
    ? []
    : issueListTargets(
        capableEnvironments.map((e) => e.environmentId),
        filterProjects,
        hideProjects,
        listInput,
      );
  const list = useIssueList(targets);
  // Refreshing a list still loading would cancel it and start over, losing the scopes already read.
  useLiveRefresh(
    () => {
      if (!list.isPending) list.reload();
    },
    { key: JSON.stringify(targets) },
  );

  const [pages, setPages] = useState<ReadonlyMap<EnvironmentId, HeldIssuePage>>(new Map());
  const held = holdIssuePages(list.answers, pages);
  const loadPage = useAtomCommand(issueEnvironment.listPage, { reportFailure: false });
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  // One tracker group's button carries on that tracker's scopes only.
  const loadMore = async (environmentId: EnvironmentId, trackerHost: string) => {
    const page = held.get(environmentId);
    const cursors = page ? issueCursorsForHost(page.nextCursors, trackerHost) : {};
    if (!page || Object.keys(cursors).length === 0 || loadingMore !== null) return;
    const input = targets.find((target) => target.environmentId === environmentId)?.input;
    if (!input) return;
    setLoadingMore(`${environmentId} ${trackerHost}`);
    const result = await loadPage({ environmentId, input: { ...input, cursors } });
    setLoadingMore(null);
    const failure = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
    setPages((current) => {
      const next = new Map(current);
      next.set(
        environmentId,
        continueIssuePage(
          page,
          result._tag === "Failure"
            ? {
                failure:
                  failure instanceof Error ? failure.message : m(msg("The next page failed.")),
              }
            : result.value,
          cursors,
        ),
      );
      return next;
    });
  };

  const chosenHost = host?.toLowerCase();
  const shown =
    chosenHost || hiddenProjects.size > 0
      ? new Map(
          [...held].map(([environmentId, page]) => [
            environmentId,
            {
              ...page,
              entries: page.entries.filter(
                (entry) =>
                  !hiddenProjects.has(
                    pullRequestProjectKey({ environmentId, id: entry.projectId }),
                  ),
              ),
              errors: page.errors.filter(
                (error) =>
                  !hiddenProjects.has(
                    pullRequestProjectKey({ environmentId, id: error.projectId }),
                  ),
              ),
              answer: {
                ...page.answer,
                scopes: page.answer.scopes?.filter(
                  (scope) =>
                    !hiddenProjects.has(
                      pullRequestProjectKey({ environmentId, id: scope.projectId }),
                    ),
                ),
                trackers: chosenHost
                  ? page.answer.trackers.filter(
                      (tracker) => tracker.host.toLowerCase() === chosenHost,
                    )
                  : page.answer.trackers,
              },
            },
          ]),
        )
      : held;
  const groups = groupIssues(shown, debouncedQuery, projects, order ?? "updated");
  const filterScopes = issueFilterScopes(
    shown,
    projects.filter((project) => !hiddenProjects.has(pullRequestProjectKey(project))),
  );

  const hostOptions = hostOptionsFor(
    [...held.values()].flatMap((page) => page.answer.trackers),
    host,
    resolve,
  );

  const applyListPatch = (patch: Partial<IssueListPreferences>) => {
    const next = issueListPreferences({
      who: "who" in patch ? (patch.who ?? "all") : who,
      status: "status" in patch ? (patch.status ?? "open") : status,
      hideProjects: "hideProjects" in patch ? patch.hideProjects : hideProjects,
      host: "host" in patch ? patch.host : host,
      q: "q" in patch ? patch.q : queryText || undefined,
      label: "label" in patch ? patch.label : labels,
      assignee: "assignee" in patch ? patch.assignee : assignee,
      order: "order" in patch ? patch.order : order,
    });
    writeIssueListPreferences(next);
    updateSearch({
      mode: "issues",
      who: next.who,
      status: next.status,
      hideProjects: next.hideProjects,
      host: next.host,
      trackerQuery: next.q,
      trackerLabels: next.label,
      trackerAssignee: next.assignee,
      order: next.order,
    });
  };

  const selectEntry = (entry: IssueRowTarget) => {
    const panels = useRightPanelStore.getState();
    panels.openIssue(panelRef, entry);
    updateSearch({
      mode: "issues",
      ...requirementSelection(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, panelRef),
      ),
    });
  };

  const showTracker = groups.length > 1;
  const noneAnswered = list.answers.length === 0;

  const listBody: ReactNode = !issuesSupported ? (
    <PullRequestsUnavailableState
      title={t("Issues unavailable")}
      error={t("Update this environment's T3 Code server to browse issues.")}
    />
  ) : noneAnswered && list.isPending ? (
    <PullRequestListGhost />
  ) : noneAnswered && list.error ? (
    <PullRequestsUnavailableState
      error={list.error}
      onRetry={list.retry}
      refreshing={list.isPending}
    />
  ) : everyProjectHidden ? (
    <Empty>
      <EmptyMedia variant="icon">
        <IssueGlyph.issue />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>
          <T>Every project is hidden</T>
        </EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={() => applyListPatch({ hideProjects: undefined })}>
          <T>Show all projects</T>
        </Button>
      </EmptyContent>
    </Empty>
  ) : groups.length === 0 ? (
    <Empty>
      <EmptyMedia variant="icon">
        <IssueGlyph.issue />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{t("No trackers to read")}</EmptyTitle>
        <EmptyDescription>
          {t("Add a project whose remote is on a supported tracker.")}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : (
    <div className="flex flex-col gap-6">
      {list.error ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-surface px-3 py-2 text-xs">
          <span>
            <T>
              <Var>{list.error}</Var> Showing the issues that loaded.
            </T>
          </span>
          <Button size="xs" variant="outline" onClick={list.retry}>
            {t("Retry")}
          </Button>
        </div>
      ) : null}
      {groups.map((group) => {
        const presentation = issueTrackerPresentation(group.tracker.tracker);
        const showScope = new Set(group.rows.map((row) => row.scope.toLowerCase())).size > 1;
        return (
          <section key={issueTrackerKey(group.tracker)} className="flex flex-col gap-1">
            <h2 className="flex items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground">
              <presentation.Icon aria-hidden className="size-3.5" />
              {presentation.providerName}
              {presentation.providerName.toLowerCase() !== group.tracker.host ? (
                <span className="font-normal">· {group.tracker.host}</span>
              ) : null}
              <span className="font-normal">
                ·{" "}
                {gt("{count, plural, one {{count} project} other {{count} projects}}", {
                  count: group.tracker.projectCount,
                })}
              </span>
            </h2>
            {!group.tracker.configured ? (
              <p className="px-3 text-sm text-muted-foreground">
                {group.tracker.detail === null
                  ? gt("This tracker cannot be read right now.")
                  : issueTrackerDetailText(group.tracker.detail, resolve)}
              </p>
            ) : null}
            {group.errors.map((error) => (
              <p
                key={`${error.environmentId}:${error.projectTitle}`}
                className="px-3 text-xs text-destructive"
              >
                {error.projectTitle}: {error.message}
              </p>
            ))}
            {group.tracker.configured && group.rows.length === 0 && group.errors.length === 0 ? (
              <p className="px-3 text-sm text-muted-foreground">
                {debouncedQuery ? t("Nothing matches that.") : t("No issues under these filters.")}
              </p>
            ) : null}
            {group.rows.map((row) => {
              const key = issueEntryKey(row);
              const selected = surfaceMatchesRow(renderedSurface, row, fallbackEnvironmentId);
              return (
                <IssueRow
                  key={`${row.environmentId}:${key}`}
                  entry={row}
                  selected={selected}
                  showScope={showScope}
                  showTracker={showTracker}
                  {...(capableEnvironments.length > 1 && environmentLabels.has(row.environmentId)
                    ? { environmentLabel: environmentLabels.get(row.environmentId) }
                    : {})}
                  onSelect={selectEntry}
                />
              );
            })}
            {group.more.map((environmentId) => {
              const moreFailure = held.get(environmentId)?.moreFailure ?? null;
              return (
                <Fragment key={environmentId}>
                  {moreFailure === null ? null : (
                    <p className="px-3 text-xs text-destructive">{moreFailure}</p>
                  )}
                  <Button
                    size="sm"
                    variant="ghost-muted"
                    className="self-start"
                    disabled={loadingMore !== null}
                    onClick={() => void loadMore(environmentId, group.tracker.host)}
                  >
                    {loadingMore === `${environmentId} ${group.tracker.host}`
                      ? t("Loading…")
                      : moreFailure === null
                        ? t("Load more")
                        : t("Retry")}
                  </Button>
                </Fragment>
              );
            })}
          </section>
        );
      })}
    </div>
  );

  return (
    <div className="@container/issue-list topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
      <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 basis-full @lg/issue-list:min-w-48 @lg/issue-list:basis-0 @lg/issue-list:flex-1">
            <PullRequestSearchInput
              value={queryText}
              label={t("Search issues")}
              placeholder={t("Search issues")}
              busy={queryText !== debouncedQuery || (debouncedQuery.length > 0 && list.isPending)}
              onChange={(q) => applyListPatch({ q: q || undefined })}
              onSubmit={(q) => applyListPatch({ q: q || undefined })}
            />
          </div>
          <PullRequestCompactFilterMenu
            label={t("Sort issues")}
            triggerIcon={<ArrowDownUpIcon aria-hidden className="size-4" />}
            triggerLabel={t("Sort")}
            outlined
            value={order ?? "updated"}
            options={resolveFilterOptions(SORT_OPTIONS, resolve)}
            onChange={(nextOrder) =>
              applyListPatch({ order: nextOrder === "created" ? "created" : undefined })
            }
          />
          <IssueFiltersMenu
            state={status}
            stateOptions={resolveFilterOptions(STATE_TABS, resolve)}
            onState={(nextStatus) => applyListPatch({ status: nextStatus })}
            involvement={who}
            involvementOptions={resolveFilterOptions(INVOLVEMENT_TABS, resolve)}
            onInvolvement={(nextWho) => applyListPatch({ who: nextWho })}
            scopes={filterScopes}
            labels={labels ?? []}
            onLabels={(nextLabels) =>
              applyListPatch({ label: nextLabels.length ? nextLabels : undefined })
            }
            assignee={assignee}
            onAssignee={(nextAssignee) => applyListPatch({ assignee: nextAssignee })}
            projects={filterProjects}
            hiddenProjects={hiddenProjects}
            onHiddenProjects={(nextHidden) => applyListPatch({ hideProjects: nextHidden })}
          />
          <SavedViewsMenu
            kind={ISSUE_SAVED_VIEWS}
            preferences={currentPreferences}
            onApply={(view) =>
              applyListPatch({
                who: view.who,
                status: view.status,
                hideProjects: view.hideProjects,
                host: view.host,
                q: view.q,
                label: view.label,
                assignee: view.assignee,
                order: view.order,
              })
            }
          />
          {hostOptions.length > 1 ? (
            <FilterMenu
              label={t("Filter by tracker")}
              value={host ?? ""}
              options={hostOptions}
              onChange={(nextHost) => applyListPatch({ host: nextHost || undefined })}
            />
          ) : null}
          <Button
            size="icon"
            variant="outline"
            aria-label={t("Refresh issues")}
            onClick={list.refresh}
            disabled={list.isPending}
          >
            <RefreshIcon size="md" refreshing={list.isPending} />
          </Button>
        </div>
        {listBody}
      </WorkspacePageContainer>
    </div>
  );
}

function FilterMenu<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<PullRequestFilterOption<Value>>;
  onChange: (value: Value) => void;
}) {
  const t = useUiTranslation();
  const current = options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  return (
    <Menu>
      <MenuTrigger
        aria-label={t("{label}: {value}", { label, value: current.label })}
        render={<Button variant="outline" />}
      >
        <PullRequestFilterOptionIcon option={current} />
        <span className="truncate">{t(current.label)}</span>
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup value={value} onValueChange={(next) => onChange(next as Value)}>
          {options.map((option) => (
            <MenuRadioItem
              key={option.value}
              value={option.value}
              disabled={option.unavailable !== undefined}
            >
              <span className="flex min-w-0 items-center gap-2">
                <PullRequestFilterOptionIcon option={option} />
                <span className="min-w-0 flex-1 truncate">{t(option.label)}</span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { msg, useGT } from "gt-react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { isMeituanServiceEnabled } from "@t3tools/contracts";
import {
  parseBranchIssueUrl,
  type IssueProvider,
  type IssueTrackerKind,
  type ProjectId,
  type EnvironmentId,
  type ScopedThreadRef,
  type WorkItemCommandInput,
  type WorkItemId,
} from "@t3tools/contracts";
import {
  createRequirementOverviewAtoms,
  createRequirementPermissionAtoms,
  RequirementOverviewKey,
  type RequirementPagination,
  type EnvironmentRequirementEntry,
} from "@t3tools/client-runtime/state/requirement-board";
import {
  DEFAULT_COLLAPSED_REQUIREMENT_GROUPS,
  requirementGroups,
  type RequirementSource,
  type TrackerCreateTarget,
  prepareWorkItemCommandRetry,
} from "@t3tools/client-runtime/work-item";
import {
  SettingsIcon,
  ClipboardListIcon,
  AlertTriangleIcon,
  ServerIcon,
  RefreshCwIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SlidersHorizontalIcon,
  ListIcon,
  LayoutGridIcon,
  XIcon,
} from "lucide-react";
import { useContext, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import * as Schema from "effect/Schema";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { toastManager } from "../ui/toast";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { RightPanelTabs } from "../RightPanelTabs";
import { PanelLayoutControls } from "../chat/PanelLayoutControls";
import { PullRequestDetailPanel } from "../pullRequest/PullRequestDetailPanel";
import { PullRequestMarkdownPanelContext } from "../pullRequest/PullRequestMarkdown";
import { PullRequestSearchInput } from "../pullRequest/PullRequestListFilters";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import {
  isRequirementTracker,
  patchRequirementsSearch,
  requirementSelection,
  type RequirementSearchPatch,
} from "./requirementPanelSearch";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { usePanelAnimationSettings, usePanelPresence } from "../../panelAnimations";
import {
  REQUIREMENTS_PANEL_REF,
  selectActiveRightPanelSurface,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "../../rightPanelStore";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuCheckboxItem,
} from "../ui/menu";
import { WorkItemEditor, WorkItemDetailPanel } from "../work-items/WorkItemsPage";
import { IssueDetailPanel } from "./IssueDetailPanel";
import { IssueDetailPanel as TrackerIssueDetailPanel } from "../issue/IssueDetailPanel";
import { TrackerIssuesView } from "../issue/IssuesPage";
import { RequirementEntryItem } from "./RequirementEntryItem";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Badge } from "../ui/badge";
import { useDebouncedValue } from "../../state/queries";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { issueEnvironment } from "../../state/issues";
import {
  RequirementFilters,
  requirementViewsMatch,
  SavedViewIdentity,
} from "@t3tools/client-runtime/saved-views";
import { SavedViewsMenu, type SavedViewsKind } from "../SavedViewsMenu";
import { LabelChoices } from "../issue/IssueListFilterPickers";
import { requirementTrackerLabel } from "@t3tools/client-runtime/work-item";
import { IssueCreateDialog, TrackerCreateDialog } from "./IssueCreateDialog";
import { Popover, PopoverTrigger, PopoverPopup, PopoverTitle } from "../ui/popover";
import { RequirementCreateMenu, RequirementScanMenu } from "./RequirementBoardActions";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import type { RequirementsSearch } from "../../routes/_chat.requirements";

const requirementViews = {
  storageKey: "t3.requirements.savedViews",
  empty: [],
  list: "requirement",
  placeholder: msg("Assigned to me"),
  suggestedName: () => "",
  schema: Schema.Array(
    Schema.Struct({ ...SavedViewIdentity.fields, preferences: RequirementFilters }),
  ),
  normalize: (value) => value,
  matches: (view, value) => requirementViewsMatch(view.preferences, value),
} satisfies SavedViewsKind<RequirementFilters, RequirementFilters, unknown>;

const boardAtoms = createRequirementOverviewAtoms({
  trackers: issueEnvironment.list,
  issues: sourceControlEnvironment.issues,
  workItemsLive: serverEnvironment.workItemsLive,
  config: serverEnvironment.configValueAtom,
  settings: serverEnvironment.settingsValueAtom,
  tracked: serverEnvironment.issueWorkItems,
});
const permissionAtoms = createRequirementPermissionAtoms({
  createIssue: sourceControlEnvironment.createIssue.permissionAtom,
  mutateWorkItem: serverEnvironment.mutateWorkItem.permissionAtom,
  discoverWorkItems: serverEnvironment.discoverWorkItems.permissionAtom,
});
const CollapsedGroups = Schema.Array(Schema.String);
const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_RECORD = {} as const;
const EMPTY_MAP = new Map<string, string>();

function getShortcutContext() {
  return {
    terminalFocus: isTerminalFocused(),
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    modelPickerOpen: false,
    isWeb: !isElectron,
    isDesktop: isElectron,
  };
}

function isRequirementPanelSurface(surface: RightPanelSurface | null | undefined) {
  return (
    surface?.kind === "work-item" ||
    surface?.kind === "issue" ||
    surface?.kind === "requirement-issue" ||
    surface?.kind === "pull-request"
  );
}

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
            search: (previous) => patchRequirementsSearch(previous, patch),
          });
        }}
      />
    </SidebarInset>
  ) : (
    <SidebarInset className="flex h-dvh overflow-hidden">
      <Empty size="compact">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ClipboardListIcon />
          </EmptyMedia>
          <EmptyTitle>{t("Requirements board")}</EmptyTitle>
          <EmptyDescription>
            {t("Connect an environment and add a project to use the task board.")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

export function RequirementBoard({
  environmentId: fallbackEnvironmentId,
  panelRef,
  search,
  updateSearch,
  compact = false,
}: {
  environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
  panelRef?: ScopedThreadRef;
  search: RequirementsSearch;
  updateSearch: (patch: RequirementSearchPatch) => void;
  compact?: boolean;
}) {
  const t = useUiTranslation();
  const gt = useGT();
  const registry = useContext(RegistryContext);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const rightPanelRef = panelRef ?? REQUIREMENTS_PANEL_REF;
  const usesStandalonePanel = !compact && panelRef === undefined;
  const mode = usesStandalonePanel && search.mode === "issues" ? "issues" : "board";
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, rightPanelRef),
  );
  const selectedRightPanelSurface = useRightPanelStore((state) =>
    selectSelectedRightPanelSurface(state.byThreadKey, rightPanelRef),
  );
  const panelSurface =
    usesStandalonePanel && isRequirementPanelSurface(selectedRightPanelSurface)
      ? selectedRightPanelSurface
      : null;
  const panelOpen = rightPanelState.isOpen && panelSurface !== null;
  const narrow = useMediaQuery("max-sm");
  const { active: panelAnimationsActive, durationMs } = usePanelAnimationSettings();
  const { environments } = useEnvironments();
  const onlineEnvironments = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const filterEnvironmentId = compact ? fallbackEnvironmentId : search.environmentId;
  const queryEnvironmentId =
    filterEnvironmentId ?? (search.projectId ? fallbackEnvironmentId : undefined);
  const visibleEnvironments = onlineEnvironments.filter(
    (environment) => !filterEnvironmentId || environment.environmentId === filterEnvironmentId,
  );
  const queryEnvironments = onlineEnvironments.filter(
    (environment) => !queryEnvironmentId || environment.environmentId === queryEnvironmentId,
  );
  const meituanEnabled = queryEnvironments.some((environment) =>
    isMeituanServiceEnabled(environment.serverConfig?.settings, "requirements"),
  );
  const [creatingEnvironmentId, setCreatingEnvironmentId] = useState<EnvironmentId | null>(null);
  const issueFallbackEnvironmentId =
    environments.find(
      (environment) => environment.serverConfig?.environment.capabilities.issues === true,
    )?.environmentId ?? fallbackEnvironmentId;
  const detailEnvironmentId =
    search.detailEnvironmentId ??
    (search.issueTracker
      ? issueFallbackEnvironmentId
      : (filterEnvironmentId ?? fallbackEnvironmentId));
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
  const requestedSource: RequirementSource =
    search.source ?? (search.local ? "local" : (search.provider ?? "all"));
  const source = requestedSource === "meituan" && !meituanEnabled ? "all" : requestedSource;
  const view = search.view ?? "list";
  const archived = search.archived ?? false;
  const unified = queryEnvironments.some((env) => env.serverConfig?.requirementIssueTrackers);
  const includesOnes = source === "meituan" || (source === "all" && meituanEnabled);
  const supportsAdvancedInvolvement = unified && !includesOnes && source !== "local";
  const requestedInvolvement = search.workflowInvolvement;
  const involvementUnsupported =
    !supportsAdvancedInvolvement &&
    (requestedInvolvement === "authored" || requestedInvolvement === "mentioned");
  const assignee = involvementUnsupported ? "me" : (search.assignee ?? "me");
  const labels =
    !archived && source !== "local" && source !== "meituan" && unified ? (search.labels ?? []) : [];
  const queryText = search.q ?? "";
  const debouncedQuery = useDebouncedValue(queryText, 300);
  const involvement = involvementUnsupported
    ? "assigned"
    : (requestedInvolvement ?? (assignee === "me" ? "assigned" : "all"));
  const issueState = search.issueState ?? "all";
  const sort = includesOnes ? "updated" : (search.workflowSort ?? "updated");
  const [pagination, setPagination] = useState<{ key: string; pages: RequirementPagination }>({
    key: "",
    pages: {},
  });
  const environmentIds = visibleEnvironments.map((environment) => environment.environmentId);
  const queryEnvironmentIds = queryEnvironments.map((environment) => environment.environmentId);
  const permissions = useAtomValue(permissionAtoms(environmentIds));
  const filterKey = JSON.stringify([
    queryEnvironmentIds,
    source,
    assignee,
    involvement,
    issueState,
    sort,
    search.projectId,
    debouncedQuery,
    labels,
    archived,
  ]);
  if (pagination.key !== filterKey) setPagination({ key: filterKey, pages: {} });
  const data = useAtomValue(
    boardAtoms(
      new RequirementOverviewKey({
        environmentIds: mode === "issues" ? [] : queryEnvironmentIds,
        source,
        assignee,
        projectId: search.projectId ?? null,
        query: debouncedQuery,
        archived,
        labels,
        involvement,
        issueState,
        sort,
        pagination: pagination.key === filterKey ? pagination.pages : {},
      }),
    ),
  );
  const entries = data.entries;
  const entryForSurface = (surface: RightPanelSurface | null) => {
    if (
      !surface ||
      (surface.kind !== "work-item" &&
        surface.kind !== "requirement-issue" &&
        surface.kind !== "issue")
    )
      return undefined;
    const environment = surface.environmentId ?? fallbackEnvironmentId;
    let match: EnvironmentRequirementEntry | undefined;
    for (const entry of entries) {
      if (entry.environmentId !== environment) continue;
      if (surface.kind === "work-item") {
        if (entry.kind === "local" && entry.item.id === surface.workItemId) return entry;
      } else if (
        entry.kind === "issue" &&
        entry.projectId === surface.projectId &&
        entry.provider === (surface.kind === "issue" ? surface.tracker : surface.provider) &&
        entry.issue.id === (surface.kind === "issue" ? surface.key : surface.issueId) &&
        (surface.host === undefined || entry.host === surface.host) &&
        (surface.scope === undefined || entry.scope === surface.scope)
      ) {
        if (surface.host && surface.scope) return entry;
        if (match) return undefined;
        match = entry;
      }
    }
    return match;
  };
  const activeEntry = panelOpen ? entryForSurface(panelSurface) : undefined;
  const presenceValue = {
    activeSurface: panelSurface,
    surfaces: rightPanelState.surfaces.filter(isRequirementPanelSurface).map((surface) => {
      if (surface.kind === "pull-request" || ("title" in surface && surface.title)) return surface;
      const entry = entryForSurface(surface);
      return entry ? { ...surface, title: entry.title } : surface;
    }),
  };
  const presence = usePanelPresence(
    panelOpen,
    presenceValue,
    panelAnimationsActive,
    rightPanelRef.threadId,
    durationMs,
  );
  const renderedSurface = presence.value?.activeSurface ?? null;
  const errors = [
    ...data.errors.map((error) => `${environmentLabel(error.environmentId)}: ${error.message}`),
    ...data.failures.map(
      (failure) =>
        `${environmentLabel(failure.environmentId)} · ${allProjects.find((project) => project.environmentId === failure.environmentId && project.id === failure.projectId)?.title ?? failure.projectId}: ${t(failure.reason)}`,
    ),
  ];
  const [collapsed, setCollapsed] = useLocalStorage<ReadonlyArray<string>, ReadonlyArray<string>>(
    "requirements.collapsed",
    DEFAULT_COLLAPSED_REQUIREMENT_GROUPS,
    CollapsedGroups,
  );
  const [creatingIssue, setCreatingIssue] = useState<IssueProvider | null>(null);
  const [creatingTracker, setCreatingTracker] = useState<TrackerCreateTarget | null>(null);
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
  useLiveRefresh(
    () => {
      if (!data.isPending) refresh();
    },
    { enabled: mode === "board", key: `requirements:${filterKey}` },
  );
  const selectSurfaceInUrl = (surface: RightPanelSurface | null) =>
    updateSearch(requirementSelection(surface));
  const selectOpened = (patch: RequirementSearchPatch = {}) => {
    if (usesStandalonePanel)
      updateSearch({
        ...requirementSelection(
          selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, rightPanelRef),
        ),
        ...patch,
      });
  };
  const open = (entry: EnvironmentRequirementEntry) => {
    const panels = useRightPanelStore.getState();
    if (entry.kind === "local")
      panels.openWorkItem(rightPanelRef, {
        environmentId: entry.environmentId,
        workItemId: entry.item.id,
        title: entry.title,
      });
    else if (usesStandalonePanel && entry.scope && entry.issue.stateInfo) {
      panels.openIssue(rightPanelRef, {
        environmentId: entry.environmentId,
        projectId: entry.projectId,
        tracker: entry.provider,
        host: entry.host,
        scope: entry.scope,
        key: entry.issue.id,
        url: entry.issue.url,
      });
    } else
      panels.openRequirementIssue(rightPanelRef, {
        environmentId: entry.environmentId,
        projectId: entry.projectId,
        provider: entry.provider,
        host: entry.host,
        ...(entry.scope ? { scope: entry.scope } : {}),
        issueId: entry.issue.id,
        title: entry.title,
      });
    selectOpened();
  };
  const { workItemId, issueId, issueProjectId, issueScope, pullRequest } = search;
  const issueProvider = search.issueProvider ?? search.provider ?? "meituan";
  const issueTracker = search.issueTracker;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reflects browser history and deep links in the standalone panel
  useEffect(() => {
    if (!usesStandalonePanel) return;
    const panels = useRightPanelStore.getState();
    if (workItemId)
      panels.openWorkItem(rightPanelRef, { environmentId: detailEnvironmentId, workItemId });
    else if (issueId && issueProjectId && issueTracker && issueScope)
      panels.openIssue(rightPanelRef, {
        environmentId: detailEnvironmentId,
        projectId: issueProjectId,
        tracker: issueTracker,
        ...(search.issueHost ? { host: search.issueHost } : {}),
        scope: issueScope,
        key: issueId,
      });
    else if (issueId && issueProjectId)
      panels.openRequirementIssue(rightPanelRef, {
        environmentId: detailEnvironmentId,
        projectId: issueProjectId,
        provider: issueProvider,
        ...(search.issueHost ? { host: search.issueHost } : {}),
        ...(issueScope ? { scope: issueScope } : {}),
        issueId,
      });
    else if (pullRequest)
      panels.openPullRequest(rightPanelRef, {
        environmentId: detailEnvironmentId,
        projectId: pullRequest.projectId,
        repository: pullRequest.repository,
        number: pullRequest.number,
        ...(pullRequest.host ? { host: pullRequest.host } : {}),
      });
    else if (selectActiveRightPanelSurface(panels.byThreadKey, rightPanelRef))
      panels.close(rightPanelRef);
  }, [
    usesStandalonePanel,
    rightPanelRef,
    detailEnvironmentId,
    workItemId,
    issueId,
    issueProjectId,
    issueScope,
    search.issueHost,
    issueProvider,
    issueTracker,
    pullRequest,
  ]);
  const closeSurface = (surface: RightPanelSurface) => {
    useRightPanelStore.getState().closeSurface(rightPanelRef, surface.id);
    selectSurfaceInUrl(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, rightPanelRef),
    );
  };
  const panelControlsRef = useRef<HTMLDivElement>(null);
  const refocusToggleWhenOpen = useRef<boolean | null>(null);
  const toggleRightPanel = () => {
    refocusToggleWhenOpen.current = panelControlsRef.current?.matches(":focus-within")
      ? !rightPanelState.isOpen
      : null;
    if (rightPanelState.isOpen) {
      useRightPanelStore.getState().close(rightPanelRef);
      selectSurfaceInUrl(null);
      return;
    }
    if (panelSurface === null) return;
    useRightPanelStore.getState().show(rightPanelRef);
    selectSurfaceInUrl(panelSurface);
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
    useRightPanelStore.getState().openWorkItem(rightPanelRef, {
      environmentId,
      workItemId: result.value.item.id,
      title: result.value.item.title,
    });
    selectOpened({
      source: "all",
      provider: undefined,
      local: undefined,
      archived: false,
      q: undefined,
    });
    return true;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restore DOM focus after the toggle moves between the list and detail headers
  useLayoutEffect(() => {
    if (refocusToggleWhenOpen.current !== panelOpen) return;
    refocusToggleWhenOpen.current = null;
    panelControlsRef.current
      ?.querySelector<HTMLButtonElement>("[data-right-panel-toggle]")
      ?.focus({ preventScroll: true });
  }, [panelOpen]);
  const onPanelKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || isCommandPaletteOpen() || !panelSurface)
      return;
    const command = resolveShortcutCommand(event, keybindings, {
      context: { ...getShortcutContext(), rightPanelOpen: panelOpen },
    });
    if (command !== "rightPanel.toggle" && !(command === "rightPanel.close" && panelOpen)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (command === "rightPanel.close") closeSurface(panelSurface);
    else toggleRightPanel();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for panel commands on the standalone board; chat owns its own shortcuts
  useEffect(() => {
    if (!usesStandalonePanel) return;
    const handleKey = (event: KeyboardEvent) => onPanelKeyDown(event);
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [usesStandalonePanel]);
  const panelControls = usesStandalonePanel ? (
    <div
      ref={panelControlsRef}
      className="flex items-center gap-1 [-webkit-app-region:no-drag]"
      data-workspace-titlebar-controls
    >
      <PanelLayoutControls
        showTerminalControl={false}
        showThreadPanelControl={false}
        terminalAvailable={false}
        terminalOpen={false}
        terminalShortcutLabel={null}
        threadPanelOpen={false}
        threadPanelPresentation="inline"
        threadPanelShortcutLabel={null}
        onToggleThreadPanel={() => undefined}
        rightPanelAvailable={panelSurface !== null}
        rightPanelOpen={panelOpen}
        rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggle")}
        rightPanelUnavailableLabel={t("Select a requirement first")}
        onToggleTerminal={() => undefined}
        onToggleRightPanel={toggleRightPanel}
      />
    </div>
  ) : null;
  const panelEnvironmentId =
    (renderedSurface?.environmentId as EnvironmentId | undefined) ?? detailEnvironmentId;
  const renderedRequirementIssue =
    renderedSurface?.kind === "requirement-issue"
      ? renderedSurface
      : renderedSurface?.kind === "issue" &&
          isRequirementTracker(renderedSurface.tracker) &&
          environments.some(
            (environment) =>
              environment.environmentId === panelEnvironmentId &&
              environment.serverConfig?.requirementIssueTrackers === true,
          )
        ? { ...renderedSurface, provider: renderedSurface.tracker, issueId: renderedSurface.key }
        : null;
  const renderedIssueProject = renderedRequirementIssue
    ? allProjects.find(
        (project) =>
          project.environmentId === panelEnvironmentId &&
          project.id === renderedRequirementIssue.projectId,
      )
    : undefined;
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
  const activeFilters: Array<{ key: string; label: string; clear: RequirementSearchPatch }> = [];
  if (filterEnvironmentId)
    activeFilters.push({
      key: "environment",
      label: environmentLabel(filterEnvironmentId),
      clear: { environmentId: undefined, projectId: undefined },
    });
  if (source !== "all")
    activeFilters.push({
      key: "source",
      label: source === "local" ? t("Local work items") : requirementTrackerLabel[source],
      clear: { source: undefined, provider: undefined, local: undefined },
    });
  if (search.projectId !== undefined)
    activeFilters.push({
      key: "project",
      label:
        projects.find(
          (project) =>
            project.id === search.projectId &&
            project.environmentId === (filterEnvironmentId ?? fallbackEnvironmentId),
        )?.title ?? search.projectId,
      clear: { projectId: undefined },
    });
  if (labels.length)
    activeFilters.push({
      key: "labels",
      label: `${t("Labels")}: ${labels.join(", ")}`,
      clear: { labels: undefined },
    });
  if (involvement !== "assigned")
    activeFilters.push({
      key: "involvement",
      label: !["me", "all", "unassigned"].includes(assignee)
        ? assignee
        : involvement === "authored"
          ? t("Opened by me")
          : involvement === "mentioned"
            ? t("Mentioning me")
            : assignee === "unassigned"
              ? t("Unassigned")
              : assignee === "all"
                ? t("All assignees")
                : t("Everyone"),
      clear: { workflowInvolvement: undefined, assignee: undefined },
    });
  if (issueState !== "all")
    activeFilters.push({
      key: "state",
      label: issueState === "open" ? t("Open") : t("Closed"),
      clear: { issueState: undefined },
    });
  if (sort === "created")
    activeFilters.push({ key: "sort", label: t("Newest"), clear: { workflowSort: undefined } });
  if (archived)
    activeFilters.push({
      key: "archived",
      label: t("Show archived"),
      clear: { archived: undefined },
    });
  if (queryText)
    activeFilters.push({
      key: "query",
      label: `${t("Search title or number")}: ${queryText}`,
      clear: { q: undefined },
    });
  const resetFilters = () =>
    updateSearch({
      environmentId: undefined,
      source: undefined,
      provider: undefined,
      local: undefined,
      projectId: undefined,
      assignee: undefined,
      workflowInvolvement: undefined,
      issueState: undefined,
      workflowSort: undefined,
      labels: undefined,
      archived: undefined,
      q: undefined,
    });
  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <div className="relative flex h-full min-h-0 flex-1 overflow-hidden">
        <div
          className={`${panelOpen ? "max-sm:hidden flex" : "flex"} min-h-0 min-w-0 flex-1 flex-col`}
        >
          <WorkspacePageHeader
            electron={!compact && isElectron}
            reserveNativeControls={!compact && isElectron && !panelOpen}
            className={
              compact
                ? "justify-between border-b border-border px-4!"
                : "justify-between border-b border-border/60"
            }
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <ClipboardListIcon className="size-4 shrink-0 text-muted-foreground" />
              <h1 className="truncate text-sm font-semibold">{t("Requirements board")}</h1>
              {usesStandalonePanel ? (
                <ToggleGroup
                  aria-label={t("View mode")}
                  value={[mode]}
                  onValueChange={(values) => {
                    const nextMode = values[0];
                    if (nextMode === "board" || nextMode === "issues")
                      updateSearch({ mode: nextMode });
                  }}
                >
                  <ToggleGroupItem value="board">{t("Workflow")}</ToggleGroupItem>
                  <ToggleGroupItem value="issues">{t("Issues")}</ToggleGroupItem>
                </ToggleGroup>
              ) : null}
              {mode === "board" && entries.length > 0 ? (
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground tabular-nums">
                  {entries.length}
                </span>
              ) : null}
              {mode === "board" && errors.length ? (
                <Popover>
                  <PopoverTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="shrink-0"
                        aria-label={t("View loading errors")}
                      >
                        <AlertTriangleIcon className="size-3.5 text-warning-foreground" />
                      </Button>
                    }
                  />
                  <PopoverPopup align="start" width="md">
                    <div className="space-y-3">
                      <PopoverTitle>{t("Some requirements could not be loaded")}</PopoverTitle>
                      {errors.map((error) => (
                        <p key={error} className="text-xs text-muted-foreground wrap-anywhere">
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
              {mode === "board" && data.isPending && entries.length ? (
                <span
                  role="status"
                  className="inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground"
                >
                  <Spinner size="xs" tone="muted" aria-hidden="true" role={undefined} />
                  <span className="sr-only sm:not-sr-only">{t("Updating")}</span>
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {mode === "board" ? (
                <>
                  <RequirementScanMenu
                    environments={visibleEnvironments}
                    {...(search.projectId ? { projectId: search.projectId } : {})}
                    refreshed={refresh}
                  />
                  <RequirementCreateMenu
                    createTrackerIssue={(id, target) => {
                      setCreatingEnvironmentId(id);
                      setCreatingTracker(target);
                    }}
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
                </>
              ) : null}
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label={t("Requirement settings")}
                title={t("Requirement settings")}
                render={
                  <Link
                    to="/settings/requirements"
                    search={filterEnvironmentId ? { machine: filterEnvironmentId } : {}}
                    hash="issue-trackers"
                  />
                }
              >
                <SettingsIcon />
              </Button>
              {!panelOpen && panelControls}
            </div>
          </WorkspacePageHeader>
          {mode === "board" ? (
            <>
              <div className="flex shrink-0 items-center gap-1.5 px-5 pt-3 pb-2">
                {!compact ? (
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button size="sm" variant="outline" aria-label={t("Environment")}>
                          <ServerIcon />
                          <span className="max-w-36 truncate">
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
                              ...requirementSelection(null),
                            })
                          }
                        >
                          {environment.label}
                        </MenuCheckboxItem>
                      ))}
                    </MenuPopup>
                  </Menu>
                ) : null}
                <div className="min-w-0 flex-1">
                  <PullRequestSearchInput
                    value={queryText}
                    label={t("Search title or number")}
                    placeholder={t("Search title or number")}
                    busy={
                      queryText !== debouncedQuery || (debouncedQuery.length > 0 && data.isPending)
                    }
                    onChange={(q) => updateSearch({ q: q || undefined })}
                    onSubmit={(q) => updateSearch({ q: q || undefined })}
                  />
                </div>
                <SavedViewsMenu
                  size="sm"
                  kind={requirementViews}
                  preferences={{
                    source,
                    assignee,
                    archived,
                    labels,
                    environmentId: filterEnvironmentId ?? null,
                    projectId: search.projectId ?? null,
                    query: queryText,
                    involvement,
                    issueState,
                    sort,
                  }}
                  onApply={(saved) =>
                    updateSearch({
                      ...requirementSelection(null),
                      source: saved.source,
                      assignee: saved.assignee,
                      archived: saved.archived,
                      labels: saved.labels,
                      workflowInvolvement: saved.involvement,
                      issueState: saved.issueState,
                      workflowSort: saved.sort,
                      environmentId: saved.environmentId ?? undefined,
                      projectId: saved.projectId ?? undefined,
                      q: saved.query || undefined,
                      local: undefined,
                      provider: undefined,
                    })
                  }
                />
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
                            { value: "meituan", label: gt("MEP ONES") },
                            { value: "github", label: gt("GitHub Issues") },
                            { value: "gitlab", label: "GitLab" },
                            { value: "linear", label: gt("Linear") },
                            { value: "local", label: t("Local work items") },
                          ] as const
                        )
                          .filter(
                            (option) =>
                              (option.value !== "meituan" || meituanEnabled) &&
                              (unified || (option.value !== "gitlab" && option.value !== "linear")),
                          )
                          .map((option) => (
                            <MenuCheckboxItem
                              key={option.value}
                              checked={source === option.value}
                              onCheckedChange={() =>
                                updateSearch({
                                  source: option.value,
                                  provider: undefined,
                                  local: undefined,
                                  assignee: undefined,
                                  workflowInvolvement: undefined,
                                  workflowSort: undefined,
                                  labels: undefined,
                                  ...requirementSelection(null),
                                })
                              }
                            >
                              {option.label}
                            </MenuCheckboxItem>
                          ))}
                      </MenuSubPopup>
                    </MenuSub>
                    {labels.length || data.scopes.some((scope) => scope.labels) ? (
                      <MenuSub>
                        <MenuSubTrigger>
                          {t("Labels")}
                          {labels.length ? ` (${labels.length})` : ""}
                        </MenuSubTrigger>
                        <MenuSubPopup>
                          <LabelChoices
                            scopes={data.scopes.filter((scope) => scope.labels)}
                            value={labels}
                            onChange={(value) =>
                              updateSearch({ labels: value.length ? value : undefined })
                            }
                          />
                        </MenuSubPopup>
                      </MenuSub>
                    ) : null}
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
                                (filterEnvironmentId ?? fallbackEnvironmentId) ===
                                  project.environmentId
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
                        <MenuSubTrigger>{t("Involvement")}</MenuSubTrigger>
                        <MenuSubPopup>
                          {(
                            [
                              { value: "assigned", label: t("Assigned to me") },
                              { value: "all", label: t("Everyone") },
                              { value: "authored", label: t("Opened by me") },
                              { value: "mentioned", label: t("Mentioning me") },
                            ] as const
                          )
                            .filter(
                              (option) =>
                                supportsAdvancedInvolvement ||
                                (option.value !== "authored" && option.value !== "mentioned"),
                            )
                            .map((option) => (
                              <MenuCheckboxItem
                                key={option.value}
                                checked={involvement === option.value}
                                onCheckedChange={() =>
                                  updateSearch({
                                    workflowInvolvement: option.value,
                                    assignee: option.value === "assigned" ? "me" : "all",
                                  })
                                }
                              >
                                {option.label}
                              </MenuCheckboxItem>
                            ))}
                        </MenuSubPopup>
                      </MenuSub>
                    ) : null}
                    <MenuSub>
                      <MenuSubTrigger>{t("State")}</MenuSubTrigger>
                      <MenuSubPopup>
                        {(
                          [
                            { value: "all", label: t("All states") },
                            { value: "open", label: t("Open") },
                            { value: "closed", label: t("Closed") },
                          ] as const
                        ).map((option) => (
                          <MenuCheckboxItem
                            key={option.value}
                            checked={issueState === option.value}
                            onCheckedChange={() => updateSearch({ issueState: option.value })}
                          >
                            {option.label}
                          </MenuCheckboxItem>
                        ))}
                      </MenuSubPopup>
                    </MenuSub>
                    <MenuSub>
                      <MenuSubTrigger>{t("Sort")}</MenuSubTrigger>
                      <MenuSubPopup>
                        <MenuCheckboxItem
                          checked={sort === "updated"}
                          onCheckedChange={() => updateSearch({ workflowSort: "updated" })}
                        >
                          {t("Recently updated")}
                        </MenuCheckboxItem>
                        <MenuCheckboxItem
                          checked={sort === "created"}
                          disabled={includesOnes}
                          onCheckedChange={() => updateSearch({ workflowSort: "created" })}
                        >
                          {t("Newest")}
                        </MenuCheckboxItem>
                      </MenuSubPopup>
                    </MenuSub>
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
                              onCheckedChange={() =>
                                updateSearch({
                                  assignee: person.value,
                                  workflowInvolvement: person.value === "me" ? "assigned" : "all",
                                })
                              }
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
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={
                          view === "list" ? t("Switch to board view") : t("Switch to list view")
                        }
                        onClick={() => updateSearch({ view: view === "list" ? "board" : "list" })}
                      />
                    }
                  >
                    {view === "list" ? <ListIcon /> : <LayoutGridIcon />}
                  </TooltipTrigger>
                  <TooltipPopup>
                    {view === "list" ? t("Switch to board view") : t("Switch to list view")}
                  </TooltipPopup>
                </Tooltip>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("Refresh issues")}
                  aria-busy={data.isPending}
                  disabled={data.isPending}
                  onClick={refresh}
                >
                  <RefreshIcon refreshing={data.isPending} />
                </Button>
              </div>
              {activeFilters.length ? (
                <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-5 pb-2">
                  {activeFilters.map((filter) => (
                    <Badge
                      key={filter.key}
                      size="sm"
                      variant="secondary"
                      render={
                        <button
                          type="button"
                          aria-label={`${filter.label}, ${t("Reset filters")}`}
                          onClick={() => updateSearch(filter.clear)}
                        />
                      }
                    >
                      <span className="max-w-56 truncate">{filter.label}</span>
                      <XIcon aria-hidden />
                    </Badge>
                  ))}
                  <Button size="xs" variant="ghost-muted" onClick={resetFilters}>
                    {t("Reset filters")}
                  </Button>
                </div>
              ) : null}
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
                  <Empty size="compact">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <AlertTriangleIcon />
                      </EmptyMedia>
                      <EmptyTitle>{t("Some requirements could not be loaded")}</EmptyTitle>
                      <EmptyDescription>{errors[0]}</EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                      <Button size="sm" variant="outline" onClick={refresh}>
                        <RefreshCwIcon />
                        {t("Retry")}
                      </Button>
                    </EmptyContent>
                  </Empty>
                ) : !entries.length ? (
                  <Empty size="compact">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <ClipboardListIcon />
                      </EmptyMedia>
                      <EmptyTitle>{t("No matching work items.")}</EmptyTitle>
                      <EmptyDescription>
                        {t("Create or scan items, or adjust your filters.")}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div
                    className={
                      view === "board"
                        ? "flex min-h-0 flex-1 gap-4 overflow-x-auto pb-2"
                        : "space-y-4"
                    }
                  >
                    {requirementGroups(t).map((group) => {
                      const rows = entries.filter((entry) => entry.group === group.key);
                      if (!rows.length) return null;
                      const folded = collapsed.includes(group.key);
                      const accentClass =
                        group.key === "attention"
                          ? "bg-destructive"
                          : group.key === "done"
                            ? "bg-success"
                            : group.key === "release"
                              ? "bg-warning"
                              : group.key === "active"
                                ? "bg-info"
                                : "bg-muted-foreground";
                      return (
                        <section
                          key={group.key}
                          className={
                            view === "board"
                              ? `flex w-72 shrink-0 flex-col rounded-xl border border-border/60 bg-muted/20 ${folded ? "self-start" : "min-h-0 self-stretch"}`
                              : "min-w-0"
                          }
                        >
                          <button
                            type="button"
                            className={`flex min-h-11 w-full shrink-0 items-center gap-2 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${view === "board" ? "sticky top-0 z-10 rounded-t-xl border-b border-border/50 bg-muted/95 px-3" : ""}`}
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
                            <span className={`size-2 shrink-0 rounded-full ${accentClass}`} />
                            <span className={group.key === "attention" ? "text-destructive" : ""}>
                              {group.label}
                            </span>
                            <Badge size="sm" variant="secondary">
                              {rows.length}
                            </Badge>
                          </button>
                          <div
                            hidden={folded}
                            className={
                              view === "board"
                                ? "min-h-0 flex-1 space-y-2 overflow-y-auto p-2"
                                : "divide-y divide-border/50"
                            }
                          >
                            {rows.map((entry) => (
                              <RequirementEntryItem
                                key={entry.key}
                                entry={entry}
                                selected={entry === activeEntry}
                                view={view}
                                environmentLabel={environmentLabel(entry.environmentId)}
                                projectTitle={
                                  projects.find(
                                    (project) =>
                                      project.id === entry.projectId &&
                                      project.environmentId === entry.environmentId,
                                  )?.title ?? entry.projectId
                                }
                                showEnvironment={
                                  onlineEnvironments.length > 1 || filterEnvironmentId !== undefined
                                }
                                onSelect={open}
                              />
                            ))}
                          </div>
                        </section>
                      );
                    })}
                  </div>
                )}
                {data.candidates.length && (source === "all" || source === "local") ? (
                  <Collapsible render={<section className="border-t border-border/60" />}>
                    <h2 className="text-sm font-medium">
                      <CollapsibleTrigger className="group flex min-h-11 w-full items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground group-data-panel-open:rotate-90" />
                        {t("Discovered tasks")}
                        <span className="text-xs text-muted-foreground">
                          {data.candidates.length}
                        </span>
                      </CollapsibleTrigger>
                    </h2>
                    <CollapsiblePanel animate={false}>
                      <div className="space-y-3 pb-4">
                        {data.candidates.map((item) => (
                          <div
                            key={`${item.environmentId}:${item.id}`}
                            className="flex items-center gap-3"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm">{item.title}</span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {environmentLabel(item.environmentId)}
                              </span>
                            </span>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                !permissions.get(item.environmentId)?.mutateWorkItem || busy
                              }
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
                      </div>
                    </CollapsiblePanel>
                  </Collapsible>
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
            </>
          ) : (
            <TrackerIssuesView
              search={search}
              updateSearch={updateSearch}
              panelRef={rightPanelRef}
              renderedSurface={renderedSurface}
              fallbackEnvironmentId={issueFallbackEnvironmentId}
            />
          )}
        </div>
        {presence.present && renderedSurface ? (
          <RightPanelTabs
            mode={narrow ? "sheet" : "inline"}
            layoutControls={panelOpen && panelControls}
            open={rightPanelState.isOpen}
            keybindings={keybindings}
            getShortcutContext={getShortcutContext}
            widthStorageKey="t3code:requirement-panel-width"
            defaultWidth={typeof window === "undefined" ? 560 : Math.floor(window.innerWidth / 2)}
            surfaces={presence.value?.surfaces ?? []}
            environmentId={panelEnvironmentId}
            activeSurfaceId={renderedSurface.id}
            pendingSurfaceIds={EMPTY_SET}
            previewSessions={EMPTY_RECORD}
            desktopByTabId={EMPTY_RECORD}
            terminalLabelsById={EMPTY_MAP}
            onActivate={(surface) => {
              useRightPanelStore.getState().activateSurface(rightPanelRef, surface.id);
              selectSurfaceInUrl(surface);
            }}
            onCloseSurface={closeSurface}
            onCloseOtherSurfaces={(surface) => {
              useRightPanelStore.getState().closeOtherSurfaces(rightPanelRef, surface.id);
              selectSurfaceInUrl(surface);
            }}
            onCloseSurfacesToRight={(surface) => {
              useRightPanelStore.getState().closeSurfacesToRight(rightPanelRef, surface.id);
              selectSurfaceInUrl(
                selectActiveRightPanelSurface(
                  useRightPanelStore.getState().byThreadKey,
                  rightPanelRef,
                ),
              );
            }}
            onCloseAllSurfaces={() => {
              useRightPanelStore.getState().closeAllSurfaces(rightPanelRef);
              selectSurfaceInUrl(null);
            }}
            onMoveSurface={(surfaceId, toIndex) =>
              useRightPanelStore.getState().moveSurface(rightPanelRef, surfaceId, toIndex)
            }
            onCopyFilePath={() => undefined}
            onAddBrowser={() => undefined}
            onAddBrowserInProfile={() => undefined}
            onAddTerminal={() => undefined}
            onAddDiff={() => undefined}
            onAddFiles={() => undefined}
            onAddPullRequest={() => undefined}
            onAddPullRequests={() => undefined}
            onAddDevice={() => undefined}
            browserAvailable={false}
            terminalAvailable={false}
            diffAvailable={false}
            filesAvailable={false}
            pullRequestAvailable={false}
            pullRequestsAvailable={false}
            deviceAvailable={false}
          >
            <PullRequestMarkdownPanelContext value={rightPanelRef}>
              {renderedSurface.kind === "work-item" ? (
                <WorkItemDetailPanel
                  key={renderedSurface.id}
                  embedded
                  panelRef={rightPanelRef}
                  environmentId={panelEnvironmentId}
                  id={renderedSurface.workItemId as WorkItemId}
                />
              ) : renderedRequirementIssue ? (
                <IssueDetailPanel
                  key={renderedSurface.id}
                  embedded
                  panelRef={rightPanelRef}
                  environmentId={panelEnvironmentId}
                  target={{
                    projectId: renderedRequirementIssue.projectId as ProjectId,
                    provider: renderedRequirementIssue.provider,
                    ...(renderedRequirementIssue.host
                      ? { host: renderedRequirementIssue.host }
                      : {}),
                    ...(renderedRequirementIssue.scope
                      ? { scope: renderedRequirementIssue.scope }
                      : {}),
                  }}
                  id={renderedRequirementIssue.issueId}
                  cwd={renderedIssueProject?.workspaceRoot ?? ""}
                  projectTitle={renderedIssueProject?.title ?? renderedRequirementIssue.projectId}
                  changed={refresh}
                  onPullRequestOpened={() => selectOpened()}
                />
              ) : renderedSurface.kind === "issue" ? (
                <TrackerIssueDetailPanel
                  key={renderedSurface.id}
                  environmentId={panelEnvironmentId}
                  reference={{
                    projectId: renderedSurface.projectId as ProjectId,
                    tracker: renderedSurface.tracker as IssueTrackerKind,
                    ...(renderedSurface.host ? { host: renderedSurface.host } : {}),
                    scope: renderedSurface.scope,
                    key: renderedSurface.key,
                  }}
                  onSelectPullRequest={(reference) => {
                    useRightPanelStore.getState().openPullRequest(rightPanelRef, {
                      projectId: reference.projectId,
                      repository: reference.repository,
                      number: reference.number,
                      ...(reference.host ? { host: reference.host } : {}),
                      environmentId: panelEnvironmentId,
                    });
                    selectOpened();
                  }}
                  onSelectIssue={({ host, ...reference }) => {
                    useRightPanelStore.getState().openIssue(rightPanelRef, {
                      ...reference,
                      ...(host === undefined ? {} : { host }),
                      environmentId: panelEnvironmentId,
                    });
                    selectOpened();
                  }}
                />
              ) : renderedSurface.kind === "pull-request" ? (
                <PullRequestDetailPanel
                  key={renderedSurface.id}
                  getShortcutContext={getShortcutContext}
                  shortcutsEnabled={panelSurface?.id === renderedSurface.id}
                  environmentId={panelEnvironmentId}
                  reference={{
                    projectId: renderedSurface.projectId as ProjectId,
                    repository: renderedSurface.repository,
                    number: renderedSurface.number,
                    ...(renderedSurface.host ? { host: renderedSurface.host } : {}),
                  }}
                />
              ) : null}
            </PullRequestMarkdownPanelContext>
          </RightPanelTabs>
        ) : null}
        {creatingTracker ? (
          <TrackerCreateDialog
            environmentId={environmentId}
            target={creatingTracker}
            close={() => {
              setCreatingTracker(null);
              setCreatingEnvironmentId(null);
            }}
            created={(issueId) => {
              useRightPanelStore.getState().openIssue(rightPanelRef, {
                environmentId,
                projectId: creatingTracker.projectId,
                tracker: creatingTracker.provider,
                scope: creatingTracker.scope,
                ...(creatingTracker.host ? { host: creatingTracker.host } : {}),
                key: issueId,
              });
              setCreatingTracker(null);
              setCreatingEnvironmentId(null);
              refresh();
              selectOpened({
                source: "all",
                local: undefined,
                provider: undefined,
                archived: false,
                q: undefined,
                labels: undefined,
              });
            }}
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
              const issueScope = parseBranchIssueUrl(issue.url)?.repository;
              setCreatingIssue(null);
              setCreatingEnvironmentId(null);
              refresh();
              useRightPanelStore.getState().openRequirementIssue(rightPanelRef, {
                environmentId,
                projectId,
                provider: creatingIssue,
                ...(issueScope ? { scope: issueScope } : {}),
                issueId: issue.id,
                title: issue.title,
              });
              selectOpened({
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

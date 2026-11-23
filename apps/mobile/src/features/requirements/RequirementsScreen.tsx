import { StackActions, useNavigation } from "@react-navigation/native";
import type { StaticScreenProps } from "@react-navigation/native";
import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import {
  requirementViewsMatch,
  type RequirementFilters,
} from "@t3tools/client-runtime/saved-views";
import { SavedViewsMenu } from "../layout/workspace/SavedViewsMenu";
import { requirementLabelsAtom } from "../issues/issueListFilters";
import { Chip } from "../../components/ui/Chip";
import { isMeituanServiceEnabled } from "@t3tools/contracts";
import {
  trackerCreateTargetKey,
  trackerCreateTargetLabel,
  trackerCreateTargets,
  requirementTrackerLabel,
  type TrackerCreateTarget,
} from "@t3tools/client-runtime/work-item";
import { IssueRoute } from "../issues/IssueRouteScreen";
import { issueEnvironment } from "../../state/issues";
import {
  EnvironmentId,
  ProjectId,
  RequirementIssueError,
  BranchIssueError,
  type IssueProvider,
  type IssueOption,
  type IssueMetadataInput,
  CommandId,
  type WorkItemCommandInput,
  type WorkItemId,
  type WorkItemSource,
  type ThreadId,
} from "@t3tools/contracts";
import { use, useContext, useRef, useState } from "react";
import * as Schema from "effect/Schema";
import {
  Keyboard,
  Linking,
  Platform,
  View,
  Pressable,
  ScrollView,
  type ScrollViewInstance,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { Sheet } from "../../components/ui/Sheet";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appBarMenuItemsFromActions } from "../../components/ui/menuActionItems";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { NativeWorkspaceTabActivityContext } from "../../native/v5-workspace-context";
import { useDebouncedValue } from "../../state/queries";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { useHardwareBack } from "../../lib/backHandler";
import { useSelectWorkspaceTab } from "../layout/workspace/useSelectWorkspaceTab";
import { useProjects, useThreadShell, useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { IssuePicker } from "./IssuePicker";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { serverEnvironment } from "../../state/server";
import { RequirementDeliveryPanel } from "./RequirementDeliveryPanel";
import { CandidateSwipeRow } from "./CandidateSwipeRow";
import {
  ProjectTag,
  Disclosure,
  EnvironmentTag,
  useRequirementGroups,
} from "./RequirementPrimitives";
import { DraftFillButton } from "./DraftFillButton";
import {
  DEFAULT_REQUIREMENT_FILTER_STATE,
  applyRequirementFilterSelection,
  findSelectedRequirementProject,
  isRequirementFilterCustomized,
  requirementProjectKey,
  type RequirementProjectRef,
} from "./requirementFilters";
import { SymbolView } from "../../components/ui/AppSymbol";
import {
  DELIVERY_PROGRESS_LABELS,
  requirementGroups,
  prepareWorkItemCommandRetry,
  type RequirementSource,
} from "@t3tools/client-runtime/work-item";

import {
  createRequirementOverviewAtoms,
  createRequirementPermissionAtoms,
  RequirementOverviewKey,
  type RequirementPagination,
  type EnvironmentRequirementEntry,
} from "@t3tools/client-runtime/state/requirement-board";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Dialog from "../../components/ui/Dialog";
import { TaskEditor, TaskDetail, type WorkItemsRouteParams } from "../work-items/WorkItemsScreen";

type Target = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  provider: IssueProvider;
  scope?: string;
  host?: string;
};
const isBranchIssueError = Schema.is(BranchIssueError);
const isIssueError = Schema.is(RequirementIssueError);

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

export function RequirementsScreen({
  route,
  workspace = false,
}: {
  route?: StaticScreenProps<WorkItemsRouteParams | undefined>["route"];
  workspace?: boolean;
}) {
  const { environments } = useEnvironments();
  const [chosenEnvironment, setEnvironment] = useState(route?.params?.environmentId ?? null);
  const environmentId = route?.params?.environmentId ?? environments[0]?.environmentId;
  const selectTab = useSelectWorkspaceTab();
  useHardwareBack(workspace && !environmentId, () => {
    selectTab("threads");
    return true;
  });
  const t = useUiTranslation();
  return environmentId ? (
    <UnifiedRequirementBoard
      key={`${environmentId}:${route?.params?.sourceMessageId ?? route?.params?.itemId ?? ""}`}
      workspace={workspace}
      environmentId={environmentId}
      onEnvironment={setEnvironment}
      filterEnvironmentId={chosenEnvironment}
      initial={
        route?.params?.environmentId && route?.params.environmentId !== environmentId
          ? undefined
          : route?.params
      }
    />
  ) : (
    <SettingsScreen workspaceRoot={workspace} title={t("Requirements board")}>
      <View className="flex-1 items-center justify-center px-5 py-12">
        <EmptyState
          variant="plain"
          title={t("Requirements board")}
          detail={t("Connect an environment and add a project to use the task board.")}
        />
      </View>
    </SettingsScreen>
  );
}

function UnifiedRequirementBoard({
  workspace,
  environmentId: fallbackEnvironmentId,
  filterEnvironmentId,
  onEnvironment,
  initial,
}: {
  workspace: boolean;
  environmentId: EnvironmentId;
  filterEnvironmentId: EnvironmentId | null;
  onEnvironment: (id: EnvironmentId | null) => void;
  initial: WorkItemsRouteParams | undefined;
}) {
  const t = useUiTranslation();
  const insets = useSafeAreaInsets();
  const workspaceTabs = useWorkspaceTabs();
  const headerOnly = use(NativeWorkspaceTabActivityContext)?.headerOnly === true;
  const navigation = useNavigation();
  const registry = useContext(RegistryContext);
  const selectTab = useSelectWorkspaceTab();
  const { environments } = useEnvironments();
  const [actionEnvironmentId, setActionEnvironmentId] = useState(fallbackEnvironmentId);
  const environmentId = actionEnvironmentId;
  const onlineEnvironments = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const visibleEnvironments = onlineEnvironments.filter(
    (environment) => !filterEnvironmentId || environment.environmentId === filterEnvironmentId,
  );
  const allProjects = useProjects().filter(
    (project) => !project.isScratch && project.archivedAt === null,
  );
  const projects = allProjects.filter((project) =>
    visibleEnvironments.some((environment) => environment.environmentId === project.environmentId),
  );
  const environmentLabel = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;
  const sourceThread = useThreadShell(
    initial?.sourceThreadId ? scopeThreadRef(environmentId, initial.sourceThreadId) : null,
  );
  const [selectedSource, setSource] = useState<RequirementSource>("all");
  const initialProjectId = initial?.projectId ?? sourceThread?.projectId ?? null;
  const [projectFilter, setProjectFilter] = useState<RequirementProjectRef | null>(
    initialProjectId
      ? {
          environmentId: sourceThread?.environmentId ?? fallbackEnvironmentId,
          projectId: initialProjectId,
        }
      : null,
  );
  const projectId = projectFilter?.projectId ?? null;
  const queryEnvironmentId = filterEnvironmentId ?? projectFilter?.environmentId ?? null;
  const queryEnvironments = onlineEnvironments.filter(
    (environment) => !queryEnvironmentId || environment.environmentId === queryEnvironmentId,
  );
  const [assignee, setAssignee] = useState("me");
  const [queryText, setQueryText] = useState("");
  const query = useDebouncedValue(queryText.trim(), 180);
  const [archived, setArchived] = useState(false);
  const [view, setView] = useState<"list" | "board">("list");
  const [createSheetOpen, setCreateSheetOpen] = useState(false);
  const [pagination, setPagination] = useState<{ key: string; pages: RequirementPagination }>({
    key: "",
    pages: {},
  });
  const environmentIds = visibleEnvironments.map((environment) => environment.environmentId);
  const queryEnvironmentIds = queryEnvironments.map((environment) => environment.environmentId);
  const meituanEnabled = queryEnvironments.some((environment) =>
    isMeituanServiceEnabled(environment.serverConfig?.settings, "requirements"),
  );
  const source = selectedSource === "meituan" && !meituanEnabled ? "all" : selectedSource;
  const unified = queryEnvironments.some((env) => env.serverConfig?.requirementIssueTrackers);
  const [picked, setPicked] = useAtom(requirementLabelsAtom);
  const labels =
    unified && !archived && source !== "meituan" && source !== "local" ? picked.labels : [];
  const permissions = useAtomValue(permissionAtoms(environmentIds));
  const filterKey = JSON.stringify([
    queryEnvironmentIds,
    labels,
    source,
    projectId,
    assignee,
    query,
    archived,
  ]);
  if (pagination.key !== filterKey) setPagination({ key: filterKey, pages: {} });
  const config = useEnvironmentServerConfig(environmentId);
  const data = useAtomValue(
    boardAtoms(
      new RequirementOverviewKey({
        environmentIds: queryEnvironmentIds,
        labels,
        source,
        projectId,
        assignee,
        query,
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
  const projectKey = requirementProjectKey;
  const { collapsed, toggle } = useRequirementGroups();
  const canOperate = useAtomValue(serverEnvironment.mutateWorkItem.permissionAtom(environmentId));
  const mutate = useAtomCommand(serverEnvironment.mutateWorkItem, { reportFailure: false });
  const discover = useAtomCommand(serverEnvironment.discoverWorkItems, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const retries = useRef(new Map<string, CommandId>());
  const [selectedId, setSelectedId] = useState<WorkItemId | null>(initial?.itemId ?? null);
  const sourceRef = initial?.sourceThreadId
    ? {
        threadId: initial.sourceThreadId,
        title: initial.sourceTitle ?? sourceThread?.title ?? t("Chat"),
        ...(initial.sourceMessageId ? { messageId: initial.sourceMessageId } : {}),
      }
    : undefined;
  const [creating, setCreating] = useState<{
    projectId: ProjectId;
    source?: WorkItemSource;
    description: string;
  } | null>(() => {
    const project = initial?.projectId ?? sourceThread?.projectId ?? projects[0]?.id;
    return initial?.sourceText && project
      ? {
          projectId: project,
          ...(sourceRef ? { source: sourceRef } : {}),
          description: initial.sourceText,
        }
      : null;
  });
  const detail = useEnvironmentQuery(
    selectedId && config?.workItems === true
      ? serverEnvironment.workItemsLive({ environmentId, input: { id: selectedId } })
      : null,
  );
  const scrollRef = useRef<ScrollViewInstance>(null);
  const openCandidateSwipe = useRef<SwipeableMethods | null>(null);
  const listOffset = useRef(0);
  const pendingRestoreOffset = useRef<number | null>(null);
  const showItem = (id: WorkItemId) => {
    setSelectedId(id);
  };
  const back = () => {
    pendingRestoreOffset.current = listOffset.current;
    setCreating(null);
    setSelectedId(null);
  };
  useHardwareBack(workspace, () => {
    if (Keyboard.isVisible()) Keyboard.dismiss();
    else if (!busy) {
      if (createSheetOpen) setCreateSheetOpen(false);
      else if (creating || selectedId) back();
      else selectTab("threads");
    }
    return true;
  });
  const refresh = () => {
    for (const atom of data.atoms) registry.refresh(atom);
  };
  const runOnEnvironment = async (
    targetEnvironmentId: EnvironmentId,
    input: WorkItemCommandInput,
  ) => {
    if (
      pending.current ||
      !registry.get(serverEnvironment.mutateWorkItem.permissionAtom(targetEnvironmentId))
    )
      return null;
    const request = prepareWorkItemCommandRetry(input, retries.current);
    pending.current = true;
    setBusy(true);
    const response = await mutate({
      environmentId: targetEnvironmentId,
      input: request.input,
    }).finally(() => {
      pending.current = false;
      setBusy(false);
    });
    if (response._tag === "Failure") {
      Dialog.alert(t("Could not update task"), String(squashAtomCommandFailure(response)));
      return null;
    }
    retries.current.delete(request.key);
    return response.value.item;
  };
  const run = (input: WorkItemCommandInput) => runOnEnvironment(environmentId, input);
  const canDiscover = (id: EnvironmentId) => {
    const config = registry.get(serverEnvironment.configValueAtom(id));
    return config?.workItemDiscovery === true && config.settings.workItemDiscoveryEnabled;
  };
  const scan = async (
    target: { environmentId: EnvironmentId; projectId: ProjectId },
    dismissThreadId?: ThreadId,
  ) => {
    if (
      pending.current ||
      !registry.get(serverEnvironment.discoverWorkItems.permissionAtom(target.environmentId)) ||
      !canDiscover(target.environmentId)
    )
      return;
    pending.current = true;
    setBusy(true);
    const result = await discover({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, ...(dismissThreadId ? { dismissThreadId } : {}) },
    }).finally(() => {
      pending.current = false;
      setBusy(false);
    });
    if (result._tag === "Failure")
      Dialog.alert(t("Could not scan chats"), String(squashAtomCommandFailure(result)));
    refresh();
  };
  const createLocal = (
    target: { environmentId: EnvironmentId; projectId: ProjectId },
    source?: WorkItemSource,
    description = "",
  ) => {
    setActionEnvironmentId(target.environmentId);
    setCreating({ projectId: target.projectId, ...(source ? { source } : {}), description });
  };
  const open = (entry: EnvironmentRequirementEntry) => {
    if (entry.kind === "local") {
      setActionEnvironmentId(entry.environmentId);
      showItem(entry.item.id);
    } else if (entry.provider === "gitlab" || entry.provider === "linear") {
      navigation.navigate("Issue", {
        environmentId: entry.environmentId,
        projectId: entry.projectId,
        tracker: entry.provider,
        scope: entry.scope,
        host: entry.host,
        issueKey: entry.issue.id,
      });
    } else
      navigation.navigate("IssueDetail", {
        environmentId: entry.environmentId,
        projectId: entry.projectId,
        provider: entry.provider,
        id: entry.issue.id,
        scope: entry.scope,
        host: entry.host,
      });
  };
  const people = [
    ...new Map(
      data.issuePages
        .flatMap((page) =>
          page.groups.flatMap((group) => group.issues.flatMap((issue) => issue.assignees)),
        )
        .map((person) => [person.value, person]),
    ).values(),
  ];
  if (!people.some((person) => person.value === assignee))
    people.push({ value: assignee, label: assignee });
  const renderRow = (entry: EnvironmentRequirementEntry) => (
    <Pressable
      key={entry.key}
      accessibilityRole="button"
      onPress={() => open(entry)}
      className={
        view === "board"
          ? "gap-2 rounded-xl border border-border-subtle bg-card p-3"
          : "gap-2 border-b border-border-subtle py-3"
      }
    >
      <View className="flex-row items-start gap-3">
        <Text className="min-w-0 flex-1 text-base font-t3-medium">{entry.title}</Text>
        {entry.priority ? (
          <Text
            className={
              entry.priority === "P0" || entry.priority === "P1"
                ? "shrink-0 text-xs font-t3-semibold text-warning-foreground"
                : "shrink-0 text-xs text-foreground-muted"
            }
          >
            {entry.priority}
          </Text>
        ) : null}
      </View>
      <View className="flex-row items-end gap-2">
        <View className="min-w-0 flex-1 gap-2">
          <View className="flex-row flex-wrap items-center gap-2">
            <ProjectTag
              title={
                projects.find(
                  (project) =>
                    project.id === entry.projectId && project.environmentId === entry.environmentId,
                )?.title ?? entry.projectId
              }
            />
            <Text className="text-xs text-foreground-muted">
              {entry.kind === "local"
                ? t("Local work item")
                : `${requirementTrackerLabel[entry.provider]} ${entry.provider === "linear" ? "" : "#"}${entry.issue.id}`}
            </Text>
            {entry.kind === "local" ? (
              <Text
                accessibilityLabel={`${entry.item.activeExecutionCount} ${t("Active agents")}`}
                className="text-xs text-foreground-muted"
              >
                {t("Agent({count})", { count: entry.item.activeExecutionCount })}
              </Text>
            ) : (
              <Text className="text-xs text-foreground-muted">
                {entry.issue.assignees.map((person) => person.label).join(", ") || t("Unassigned")}
              </Text>
            )}
          </View>
          {entry.summary || entry.kind !== "local" || entry.item.status === "in_review" ? (
            <View className="flex-row flex-wrap items-center gap-3">
              {entry.summary && entry.summary.requiredPullRequests > 0 ? (
                <Text className="text-xs text-foreground-muted">
                  PR {entry.summary.mergedPullRequests}/{entry.summary.requiredPullRequests}
                </Text>
              ) : null}
              <Text
                className={
                  entry.group === "attention"
                    ? "text-xs text-danger"
                    : "text-xs text-foreground-muted"
                }
              >
                {entry.summary
                  ? t(
                      entry.summary.synced && entry.summary.progress === "delivery_complete"
                        ? "Completed"
                        : DELIVERY_PROGRESS_LABELS[entry.summary.progress],
                    )
                  : entry.kind === "local"
                    ? t(entry.state)
                    : entry.state}
              </Text>
            </View>
          ) : null}
        </View>
        <EnvironmentTag label={environmentLabel(entry.environmentId)} />
      </View>
    </Pressable>
  );
  const renderGroup = (group: ReturnType<typeof requirementGroups>[number]) => {
    const rows = entries.filter((entry) => entry.group === group.key);
    if (!rows.length) return null;
    return (
      <View
        key={group.key}
        className={view === "board" ? "rounded-2xl bg-grouped-card px-3 pb-1" : undefined}
        style={view === "board" ? { width: 288 } : undefined}
      >
        <Disclosure
          title={group.label}
          count={rows.length}
          open={!collapsed.includes(group.key)}
          onToggle={() => toggle(group.key)}
          borderless={view === "board"}
        >
          {rows.map(renderRow)}
        </Disclosure>
      </View>
    );
  };
  const showingList = !creating && !selectedId;
  const filterState = {
    environmentId: filterEnvironmentId,
    source,
    project: projectFilter,
    assignee,
    archived,
    queryText,
  };
  const isFiltered = isRequirementFilterCustomized(filterState) || labels.length > 0;
  const applyFilterState = (next: typeof filterState) => {
    onEnvironment(next.environmentId);
    setSource(next.source);
    setProjectFilter(next.project);
    setAssignee(next.assignee);
    setArchived(next.archived);
    setQueryText(next.queryText);
  };
  const resetFilters = () => {
    setPicked({ labels: [], assignee: null });
    applyFilterState(DEFAULT_REQUIREMENT_FILTER_STATE);
  };
  const assigneeChoices = [
    { value: "me", label: t("Assigned to me") },
    { value: "all", label: t("All assignees") },
    { value: "unassigned", label: t("Unassigned") },
    ...people.filter((person) => !["me", "all", "unassigned"].includes(person.value)),
  ];
  const sourceChoices = [
    { value: "all" as const, label: t("All sources") },
    ...(meituanEnabled ? [{ value: "meituan" as const, label: t("MEP ONES") }] : []),
    { value: "github" as const, label: t("GitHub Issues") },
    ...(unified
      ? ([
          { value: "gitlab", label: "GitLab" },
          { value: "linear", label: t("Linear") },
        ] as const)
      : []),
    { value: "local" as const, label: t("Local work items") },
  ];
  const selectedProject = findSelectedRequirementProject(allProjects, projectFilter);
  const environmentActions = [
    {
      id: "env:",
      title: t("All environments"),
      state: filterEnvironmentId === null ? ("on" as const) : ("off" as const),
    },
    ...onlineEnvironments.map((environment) => ({
      id: `env:${environment.environmentId}`,
      title: environment.label,
      state: filterEnvironmentId === environment.environmentId ? ("on" as const) : ("off" as const),
    })),
  ];
  const sourceActions = sourceChoices.map((option) => ({
    id: `source:${option.value}`,
    title: option.label,
    state: source === option.value ? ("on" as const) : ("off" as const),
  }));
  const projectActions = [
    {
      id: "project:",
      title: t("All projects"),
      state: projectFilter === null ? ("on" as const) : ("off" as const),
    },
    ...projects.map((project) => ({
      id: `project:${projectKey(project)}`,
      title: `${environmentLabel(project.environmentId)} · ${project.title}`,
      state:
        projectFilter?.projectId === project.id &&
        projectFilter.environmentId === project.environmentId
          ? ("on" as const)
          : ("off" as const),
    })),
  ];
  const assigneeActions = assigneeChoices.map((person) => ({
    id: `assignee:${person.value}`,
    title: person.label,
    state: assignee === person.value ? ("on" as const) : ("off" as const),
  }));
  const applyFilterSelection = (id: string) => {
    applyFilterState(applyRequirementFilterSelection(filterState, id, allProjects));
  };
  const scanItems = projects.map((project) => ({
    id: `scan:${projectKey(project)}`,
    title: `${environmentLabel(project.environmentId)} · ${project.title}`,
    disabled:
      busy ||
      !permissions.get(project.environmentId)?.discoverWorkItems ||
      !canDiscover(project.environmentId),
    onPress: () => void scan({ environmentId: project.environmentId, projectId: project.id }),
  }));
  const headerActions: ReadonlyArray<AppBarAction> = [
    {
      accessibilityLabel: view === "list" ? t("Switch to board view") : t("Switch to list view"),
      icon: view === "list" ? "list.number" : "square.grid.2x2",
      onPress: () => setView((current) => (current === "list" ? "board" : "list")),
    },
    {
      accessibilityLabel: t("New requirement"),
      icon: "plus",
      disabled: projects.length === 0 || busy,
      onPress: () => setCreateSheetOpen(true),
    },
  ];
  const headerMenu: AppBarMenu = {
    title: t("Filter requirements"),
    icon: isFiltered
      ? "line.3.horizontal.decrease.circle.fill"
      : "line.3.horizontal.decrease.circle",
    items: [
      ...appBarMenuItemsFromActions(
        [
          { id: "source", title: t("Issue source"), subactions: sourceActions },
          { id: "project", title: t("Project"), subactions: projectActions },
          ...(source !== "local"
            ? [{ id: "assignee", title: t("Assignee"), subactions: assigneeActions }]
            : []),
        ],
        applyFilterSelection,
      ),
      ...(scanItems.length > 0
        ? [
            {
              id: "scan",
              title: t("Scan chats"),
              icon: "magnifyingglass",
              items: scanItems,
            },
          ]
        : []),
      {
        id: "archived",
        title: t("Show archived"),
        selected: archived,
        onPress: () => setArchived((value) => !value),
      },
      {
        id: "refresh",
        title: t("Refresh issues"),
        icon: "arrow.clockwise",
        disabled: data.isPending,
        onPress: refresh,
      },
      {
        id: "settings",
        title: t("Requirement settings"),
        icon: "gearshape",
        onPress: () =>
          navigation.navigate(
            "SettingsRequirements",
            queryEnvironmentId ? { environmentId: queryEnvironmentId } : undefined,
          ),
      },
      {
        id: "reset",
        title: t("Reset filters"),
        disabled: !isFiltered,
        onPress: resetFilters,
      },
    ],
  };

  const bottomPadding =
    Platform.OS === "ios"
      ? Math.max(insets.bottom, 18) + 18
      : Math.max(
          Math.max(insets.bottom, 18) + 18,
          workspace ? (workspaceTabs?.bottomClearance ?? 0) + 16 : 0,
        );

  return (
    <SettingsScreen
      workspaceRoot={workspace}
      title={t("Requirements board")}
      actions={showingList ? headerActions : undefined}
      menus={showingList ? [headerMenu] : undefined}
      search={
        showingList
          ? {
              value: queryText,
              onChangeText: setQueryText,
              placeholder: t("Search title or number"),
            }
          : undefined
      }
      refresh={
        showingList
          ? {
              accessibilityLabel: t("Refresh issues"),
              disabled: data.isPending,
              onPress: refresh,
            }
          : undefined
      }
    >
      {headerOnly ? null : (
        <ScreenScrollView
          ref={scrollRef}
          key={creating ? "create" : (selectedId ?? "list")}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerClassName={showingList ? "gap-4 px-5" : "gap-4 px-5 pt-4"}
          contentContainerStyle={{ paddingBottom: bottomPadding }}
          scrollEventThrottle={100}
          onContentSizeChange={() => {
            if (showingList && pendingRestoreOffset.current !== null) {
              const targetOffset = pendingRestoreOffset.current;
              pendingRestoreOffset.current = null;
              scrollRef.current?.scrollTo({ y: targetOffset, animated: false });
            }
          }}
          onScroll={(event) => {
            if (!creating && !selectedId) listOffset.current = event.nativeEvent.contentOffset.y;
          }}
          onScrollBeginDrag={() => openCandidateSwipe.current?.close()}
          refreshControl={
            showingList ? (
              <RefreshControl
                refreshing={data.isPending && entries.length > 0}
                onRefresh={refresh}
              />
            ) : undefined
          }
        >
          {creating ? (
            <TaskEditor
              environmentId={environmentId}
              projectId={creating.projectId}
              source={creating.source}
              initialDescription={creating.description}
              item={null}
              disabled={!canOperate || busy}
              run={run}
              onCancel={back}
              onSaved={(item) => {
                setCreating(null);
                showItem(item.id);
              }}
            />
          ) : selectedId ? (
            detail.data?.item ? (
              <TaskDetail
                key={`${environmentId}/${selectedId}`}
                item={detail.data.item}
                environmentId={environmentId}
                disabled={!canOperate || busy || Boolean(detail.error)}
                busy={busy}
                run={run}
                onBack={back}
              />
            ) : (
              <View className="gap-3">
                <Button label={t("Back")} onPress={back} />
                <Text className={detail.error ? "text-danger" : "text-foreground-muted"}>
                  {detail.error ?? t(detail.isPending ? "Loading..." : "Task not found.")}
                </Text>
              </View>
            )
          ) : (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginHorizontal: -20, overflow: "visible" }}
                contentContainerStyle={{
                  paddingHorizontal: 16,
                  paddingTop: 12,
                  paddingBottom: 4,
                  gap: 8,
                }}
              >
                <ListFilterMenu
                  label={
                    filterEnvironmentId
                      ? environmentLabel(filterEnvironmentId)
                      : t("All environments")
                  }
                  accessibilityLabel={t("Environment")}
                  active={filterEnvironmentId !== null}
                  actions={environmentActions}
                  onSelect={applyFilterSelection}
                />
                <SavedViewsMenu<RequirementFilters>
                  read={(prefs) => prefs.requirementSavedViews}
                  write={(requirementSavedViews) => ({ requirementSavedViews })}
                  list="requirement"
                  suggestedName=""
                  scope={{
                    environmentId: queryEnvironmentId,
                    projectId,
                    source,
                    assignee,
                    labels,
                    archived,
                    query: queryText,
                  }}
                  matches={requirementViewsMatch}
                  onApply={(saved) => {
                    setPicked({ labels: saved.labels, assignee: null });
                    applyFilterState({
                      environmentId: saved.environmentId,
                      project:
                        saved.environmentId && saved.projectId
                          ? { environmentId: saved.environmentId, projectId: saved.projectId }
                          : null,
                      source: saved.source,
                      archived: saved.archived,
                      assignee: saved.assignee,
                      queryText: saved.query,
                    });
                  }}
                />
                {labels.length || data.scopes.some((scope) => scope.labels) ? (
                  <Chip
                    label={labels.length ? labels.join(", ") : t("Labels")}
                    accessibilityLabel={t("Labels")}
                    selected={labels.length > 0}
                    onPress={() =>
                      navigation.navigate("IssueFilterSearch", {
                        kind: "labels",
                        requirements: true,
                        scopes: data.scopes.filter((scope) => scope.labels),
                      })
                    }
                  />
                ) : null}
                <ListFilterMenu
                  label={
                    sourceChoices.find((option) => option.value === source)?.label ??
                    t("All sources")
                  }
                  accessibilityLabel={t("Issue source")}
                  active={source !== "all"}
                  actions={sourceActions}
                  onSelect={applyFilterSelection}
                />
                <ListFilterMenu
                  label={selectedProject?.title ?? t("All projects")}
                  accessibilityLabel={t("Project")}
                  active={projectFilter !== null}
                  actions={projectActions}
                  onSelect={applyFilterSelection}
                />
                {source !== "local" ? (
                  <ListFilterMenu
                    label={
                      assigneeChoices.find((option) => option.value === assignee)?.label ?? assignee
                    }
                    accessibilityLabel={t("Assignee")}
                    active={assignee !== "me"}
                    actions={assigneeActions}
                    onSelect={applyFilterSelection}
                  />
                ) : null}
                {isFiltered ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("Reset filters")}
                    className="h-8 w-8 items-center justify-center"
                    onPress={resetFilters}
                  >
                    <SymbolView
                      name="xmark.circle.fill"
                      size={18}
                      tintColorClassName="accent-icon-muted"
                    />
                  </Pressable>
                ) : null}
              </ScrollView>
              {errors.length ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("View loading errors")}
                  onPress={() =>
                    Dialog.alert(t("Some requirements could not be loaded"), errors.join("\n\n"))
                  }
                  className="flex-row items-center gap-2.5 rounded-2xl bg-subtle/80 px-3.5 py-2.5 active:opacity-70"
                >
                  <SymbolView
                    name="exclamationmark.triangle"
                    size={15}
                    tintColorClassName="accent-icon-muted"
                  />
                  <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-foreground-muted">
                    {errors.length === 1
                      ? errors[0]
                      : `${t("Some requirements could not be loaded")} (${errors.length})`}
                  </Text>
                  <SymbolView
                    name="chevron.right"
                    size={11}
                    tintColorClassName="accent-icon-muted"
                  />
                </Pressable>
              ) : null}
              {data.isPending && !entries.length ? (
                <View className="items-center py-12">
                  <AppActivityIndicator colorClassName="accent-icon" />
                </View>
              ) : !entries.length && errors.length ? (
                <EmptyState
                  variant="plain"
                  title={t("Some requirements could not be loaded")}
                  detail={errors[0] ?? ""}
                  actionLabel={t("Retry")}
                  onAction={refresh}
                />
              ) : !entries.length ? (
                <EmptyState
                  variant="plain"
                  title={t("No matching work items.")}
                  detail={t("Create or scan items, or adjust your filters.")}
                />
              ) : null}
              {data.isPending && entries.length ? (
                <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
                  {t("Updating")}
                </Text>
              ) : null}
              {view === "list" ? (
                requirementGroups(t).map(renderGroup)
              ) : (
                <ScrollView
                  horizontal
                  nestedScrollEnabled
                  directionalLockEnabled
                  showsHorizontalScrollIndicator={false}
                  style={{ marginHorizontal: -20 }}
                  contentContainerStyle={{
                    paddingHorizontal: 16,
                    gap: 14,
                    alignItems: "flex-start",
                  }}
                >
                  {requirementGroups(t).map(renderGroup)}
                </ScrollView>
              )}
              {data.hasMore ? (
                <Button
                  label={t("Load more")}
                  disabled={data.isPending}
                  onPress={() => setPagination({ key: filterKey, pages: data.nextPagination })}
                />
              ) : null}
              {data.candidates.length && (source === "all" || source === "local") ? (
                <Disclosure title={t("Discovered tasks")} count={data.candidates.length}>
                  {data.candidates.map((candidate) => (
                    <CandidateSwipeRow
                      key={`${candidate.environmentId}:${candidate.id}`}
                      candidate={candidate}
                      environmentLabel={environmentLabel(candidate.environmentId)}
                      canCreate={
                        !busy && permissions.get(candidate.environmentId)?.mutateWorkItem === true
                      }
                      canIgnore={
                        !busy &&
                        permissions.get(candidate.environmentId)?.discoverWorkItems === true &&
                        canDiscover(candidate.environmentId)
                      }
                      onCreate={() =>
                        createLocal(
                          {
                            environmentId: candidate.environmentId,
                            projectId: candidate.projectId,
                          },
                          { threadId: candidate.id, title: candidate.title },
                          candidate.description,
                        )
                      }
                      onIgnore={() => void scan(candidate, candidate.id)}
                      onWillOpen={(row) => {
                        if (openCandidateSwipe.current === row) return;
                        openCandidateSwipe.current?.close();
                        openCandidateSwipe.current = row;
                      }}
                      onClose={(row) => {
                        if (openCandidateSwipe.current === row) openCandidateSwipe.current = null;
                      }}
                    />
                  ))}
                </Disclosure>
              ) : null}
            </>
          )}
        </ScreenScrollView>
      )}
      {createSheetOpen ? (
        <RequirementCreateSheet
          projects={projects}
          environmentLabel={environmentLabel}
          defaultProject={
            selectedProject ??
            projects.find((project) => project.environmentId === environmentId) ??
            projects[0]
          }
          defaultSource={source === "all" ? "local" : source}
          busy={busy}
          run={runOnEnvironment}
          onClose={() => setCreateSheetOpen(false)}
          onCreatedLocal={(createdEnvId, item) => {
            setCreateSheetOpen(false);
            setActionEnvironmentId(createdEnvId);
            showItem(item.id);
          }}
          onTrackerCreated={(scope, id, environmentId) => {
            setCreateSheetOpen(false);
            navigation.navigate("Issue", {
              environmentId,
              projectId: scope.projectId,
              scope: scope.scope,
              tracker: scope.provider,
              ...(scope.host ? { host: scope.host } : {}),
              issueKey: id,
            });
          }}
          onCreatedIssue={(target, id) => {
            setCreateSheetOpen(false);
            navigation.navigate("IssueDetail", { ...target, id });
          }}
        />
      ) : null}
    </SettingsScreen>
  );
}

function RequirementCreateSheet({
  projects,
  environmentLabel,
  defaultProject,
  defaultSource,
  busy: parentBusy,
  run,
  onClose,
  onCreatedLocal,
  onCreatedIssue,
  onTrackerCreated,
}: {
  projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly title: string;
    readonly environmentId: EnvironmentId;
  }>;
  environmentLabel: (id: EnvironmentId) => string;
  defaultProject:
    | { readonly id: ProjectId; readonly title: string; readonly environmentId: EnvironmentId }
    | undefined;
  defaultSource: Exclude<RequirementSource, "all">;
  busy: boolean;
  run: (
    environmentId: EnvironmentId,
    input: WorkItemCommandInput,
  ) => Promise<{ readonly id: WorkItemId } | null>;
  onClose: () => void;
  onCreatedLocal: (environmentId: EnvironmentId, item: { readonly id: WorkItemId }) => void;
  onCreatedIssue: (target: Target, id: string) => void;
  onTrackerCreated: (scope: TrackerCreateTarget, key: string, env: EnvironmentId) => void;
}) {
  const t = useUiTranslation();
  const [selectedProjectKey, setSelectedProjectKey] = useState(
    defaultProject ? `${defaultProject.environmentId}/${defaultProject.id}` : "",
  );
  const project =
    projects.find((entry) => `${entry.environmentId}/${entry.id}` === selectedProjectKey) ??
    projects[0];
  const config = useEnvironmentServerConfig(project?.environmentId ?? null);
  const canCreateLocal = useAtomValue(
    serverEnvironment.mutateWorkItem.permissionAtom(
      project?.environmentId ?? EnvironmentId.make(""),
    ),
  );
  const canCreateIssue = useAtomValue(
    sourceControlEnvironment.createIssue.permissionAtom(
      project?.environmentId ?? EnvironmentId.make(""),
    ),
  );
  const localAllowed = Boolean(project && canCreateLocal && config?.workItems === true);
  const issueAllowed = Boolean(project && canCreateIssue);
  const trackerList = useEnvironmentQuery(
    project && config?.requirementIssueTrackers
      ? issueEnvironment.list({
          environmentId: project.environmentId,
          input: { state: "all", projectId: project.id, limit: 1 },
        })
      : null,
  );
  const trackerAllowed = useAtomValue(
    issueEnvironment.create.permissionAtom(project?.environmentId ?? EnvironmentId.make("")),
  );
  const trackable = trackerAllowed ? trackerCreateTargets(trackerList.data) : [];
  const [kind, setKind] = useState<string>(() => {
    if (defaultSource === "local" && !localAllowed && issueAllowed) return "github";
    if (defaultSource !== "local" && !issueAllowed && localAllowed) return "local";
    return defaultSource;
  });
  const [submitting, setSubmitting] = useState(false);

  if (!project) return null;

  const kindOptions = [
    ...trackable.map((scope) => ({
      value: trackerCreateTargetKey(scope),
      label: trackerCreateTargetLabel(scope, trackable, projects),
    })),
    ...(localAllowed ? [{ value: "local", label: t("Local work item") }] : []),
    ...(issueAllowed
      ? [
          { value: "github", label: t("GitHub Issue") },
          ...(isMeituanServiceEnabled(config?.settings, "requirements")
            ? [{ value: "meituan", label: t("MEP ONES") }]
            : []),
        ]
      : []),
  ];
  const activeKind = kindOptions.some((option) => option.value === kind)
    ? kind
    : trackable.find((scope) => scope.provider === kind)
      ? trackerCreateTargetKey(trackable.find((scope) => scope.provider === kind)!)
      : (kindOptions[0]?.value ?? "local");
  const trackerTarget = trackable.find((scope) => trackerCreateTargetKey(scope) === activeKind);

  return (
    <Sheet
      title={t("New requirement")}
      onClose={onClose}
      dismissDisabled={parentBusy || submitting}
      expanded
    >
      <ScreenScrollView
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 pt-4 pb-12"
      >
        {projects.length > 1 ? (
          <IssuePicker
            label={t("Project")}
            value={`${project.environmentId}/${project.id}`}
            options={projects.map((candidate) => ({
              value: `${candidate.environmentId}/${candidate.id}`,
              label: `${environmentLabel(candidate.environmentId)} · ${candidate.title}`,
            }))}
            disabled={parentBusy || submitting}
            onChange={setSelectedProjectKey}
          />
        ) : null}
        {kindOptions.length > 1 ? (
          <IssuePicker
            label={t("Requirement source")}
            value={activeKind}
            options={kindOptions}
            disabled={parentBusy || submitting}
            onChange={setKind}
          />
        ) : null}
        {activeKind === "local" ? (
          <TaskEditor
            key={`${project.environmentId}/${project.id}`}
            environmentId={project.environmentId}
            projectId={project.id}
            item={null}
            disabled={!localAllowed || parentBusy || submitting}
            run={async (input) => {
              setSubmitting(true);
              const created = await run(project.environmentId, input).finally(() =>
                setSubmitting(false),
              );
              return created as Awaited<ReturnType<Parameters<typeof TaskEditor>[0]["run"]>>;
            }}
            onCancel={onClose}
            onSaved={(item) => onCreatedLocal(project.environmentId, item)}
          />
        ) : trackerTarget ? (
          <TrackerCreateForm
            key={trackerCreateTargetKey(trackerTarget)}
            target={trackerTarget}
            environmentId={project.environmentId}
            busy={submitting}
            setBusy={setSubmitting}
            created={(id) => onTrackerCreated(trackerTarget, id, project.environmentId)}
          />
        ) : (
          <IssueCreateFormBody
            key={`${project.environmentId}/${project.id}/${activeKind}`}
            environmentId={project.environmentId}
            projectId={project.id}
            provider={activeKind === "meituan" ? "meituan" : "github"}
            allowProjectChange={false}
            onBusyChange={setSubmitting}
            onCreated={onCreatedIssue}
          />
        )}
      </ScreenScrollView>
    </Sheet>
  );
}

function TrackerCreateForm({
  target,
  environmentId,
  busy,
  setBusy,
  created,
}: {
  target: TrackerCreateTarget;
  environmentId: EnvironmentId;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  created: (id: string) => void;
}) {
  const t = useUiTranslation();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const create = useAtomCommand(issueEnvironment.create);
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    const { provider: _provider, ...scope } = target;
    const result = await create({
      environmentId,
      input: { ...scope, title: title.trim(), body, labels: [], assignees: [] },
    });
    setBusy(false);
    if (result._tag === "Success") created(result.value.key);
  };
  return (
    <>
      <AppTextInput
        accessibilityLabel={t("Title")}
        placeholder={t("Title")}
        value={title}
        onChangeText={setTitle}
        maxLength={1024}
        editable={!busy}
      />
      <AppTextInput
        accessibilityLabel={t("Description")}
        placeholder={t("Description")}
        multiline
        maxLength={65536}
        editable={!busy}
        value={body}
        onChangeText={setBody}
      />
      <Button
        label={t("Create issue")}
        disabled={!title.trim() || busy}
        onPress={() => void submit()}
      />
    </>
  );
}

export function IssueDetailScreen({ route }: StaticScreenProps<Target & { id: string }>) {
  const target = route.params;
  const config = useEnvironmentServerConfig(target.environmentId);
  if (
    config?.requirementIssueTrackers &&
    target.scope &&
    (target.provider !== "meituan" || isMeituanServiceEnabled(config.settings, "requirements"))
  )
    return (
      <IssueRoute
        key={`${target.environmentId}/${target.projectId}/${target.host}/${target.scope}/${target.id}`}
        params={{ ...target, tracker: target.provider, scope: target.scope, issueKey: target.id }}
        renderSupplement={(detail) => <RequirementIssueExtras target={target} url={detail.url} />}
      />
    );
  return <LegacyIssueDetail target={target} />;
}

function LegacyIssueDetail({ target }: { target: Target & { id: string } }) {
  const t = useUiTranslation();
  const insets = useSafeAreaInsets();
  const { environmentId } = target;
  const config = useEnvironmentServerConfig(environmentId);
  const enabled =
    target.provider !== "meituan" || isMeituanServiceEnabled(config?.settings, "requirements");
  const result = useEnvironmentQuery(
    enabled ? sourceControlEnvironment.issueDetail({ environmentId, input: target }) : null,
  );
  const command = useAtomCommand(sourceControlEnvironment.setIssueState);
  const canWrite = useAtomValue(
    sourceControlEnvironment.setIssueState.permissionAtom(environmentId),
  );
  const [state, setState] = useState("");
  const [busy, setBusy] = useState(false);
  const styles = useMarkdownPreviewStyles();
  const project = useProjects().find(
    (entry) => entry.environmentId === environmentId && entry.id === target.projectId,
  );
  const update = async () => {
    if (!state) return;
    setBusy(true);
    await command({ environmentId, input: { ...target, state } });
    setBusy(false);
    result.refresh();
  };
  return (
    <SettingsScreen title={t("Issue details")}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {result.error ? <Text className="text-danger">{result.error}</Text> : null}
        {result.data ? (
          <>
            <View className="gap-3">
              <ProjectTag title={project?.title ?? target.projectId} />
              <Text className="text-xl font-t3-semibold">{result.data.title}</Text>
              <Text className="text-xs text-foreground-muted">
                #{target.id} · {result.data.state} ·{" "}
                {result.data.assignees.map((person) => person.label).join(", ") || t("Unassigned")}
              </Text>
            </View>
            <RequirementIssueExtras
              target={target}
              url={result.data.url}
              transitions={result.data.transitions}
            />
            <Disclosure title={t("Change status")}>
              <IssuePicker
                label={t("Change status")}
                value={state}
                options={result.data.transitions}
                onChange={setState}
                disabled={!canWrite || busy}
              />
              <Button
                label={t("Update")}
                disabled={!canWrite || busy || !state}
                onPress={() => void update()}
              />
            </Disclosure>
            <Disclosure title={t("Description")}>
              <SelectableMarkdownText
                markdown={result.data.body || t("No description.")}
                textStyle={styles.nativeTextStyle}
                onLinkPress={(url) => {
                  if (/^https?:\/\//u.test(url)) void Linking.openURL(url);
                }}
              />
            </Disclosure>
            <Button
              label={t("View original")}
              icon="arrow.up.right"
              onPress={() => void Linking.openURL(result.data!.url)}
            />
          </>
        ) : (
          <Text>
            {t(enabled ? "Loading..." : "This service is disabled. Saved settings are retained.")}
          </Text>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function RequirementIssueExtras({
  target,
  url,
  transitions,
}: {
  target: Target & { id: string };
  url: string;
  transitions?: ReadonlyArray<IssueOption>;
}) {
  const t = useUiTranslation();
  const { environmentId } = target;
  const config = useEnvironmentServerConfig(environmentId);
  const enabled =
    target.provider !== "meituan" || isMeituanServiceEnabled(config?.settings, "requirements");
  const branchesEnabled =
    enabled &&
    (target.provider !== "meituan" || isMeituanServiceEnabled(config?.settings, "sourceControl"));
  const tracking = useEnvironmentQuery(
    config?.workItemDelivery
      ? serverEnvironment.workItemsLive({ environmentId, input: { issueUrl: url } })
      : null,
  );
  const native = useEnvironmentQuery(
    !transitions && tracking.data?.item
      ? sourceControlEnvironment.issueDetail({ environmentId, input: target })
      : null,
  );
  const [busy, setBusy] = useState(false);
  const project = useProjects().find(
    (entry) => entry.environmentId === environmentId && entry.id === target.projectId,
  );
  const branches = useEnvironmentQuery(
    project && branchesEnabled
      ? sourceControlEnvironment.issueBranches({
          environmentId,
          input: { cwd: project.workspaceRoot, url },
        })
      : null,
  );
  const link = useAtomCommand(sourceControlEnvironment.updateBranchIssues);
  const linkAllowed = useAtomValue(
    sourceControlEnvironment.updateBranchIssues.permissionAtom(environmentId),
  );
  const canLink = linkAllowed && branchesEnabled;
  const [branch, setBranch] = useState("");
  const associate = async (name: string, action: "associate" | "disassociate") => {
    if (!project) return;
    setBusy(true);
    await link({
      environmentId,
      input: { cwd: project.workspaceRoot, branch: name, action, urls: [url] },
    });
    setBusy(false);
    branches.refresh();
  };
  return (
    <>
      {tracking.data?.item ? (
        <RequirementDeliveryPanel
          environmentId={environmentId}
          item={tracking.data.item}
          summary={tracking.data.items[0]?.deliverySummary}
          transitions={transitions ?? native.data?.transitions ?? []}
        />
      ) : null}
      <Disclosure title={t("Linked branches")}>
        <Text className="text-xs text-foreground-muted">
          {t(target.provider === "meituan" ? "Synced with MEP" : "Only in this environment")}
        </Text>
        {branches.error ? (
          <Text className="text-danger">
            {isBranchIssueError(branches.failure) && branches.failure.reason === "invalid-link"
              ? t("Branch links require a repository on the same platform as the issue.")
              : branches.error}
          </Text>
        ) : null}
        {branches.data
          ?.filter((entry) => entry.linked)
          .map((entry) => (
            <View key={entry.name} className="gap-2">
              <Text>{entry.name}</Text>
              <Button
                label={t("Unlink issue")}
                disabled={!canLink || busy}
                onPress={() => void associate(entry.name, "disassociate")}
              />
            </View>
          ))}
        <IssuePicker
          label={t("Choose branch")}
          value={branch}
          options={(branches.data ?? [])
            .filter((entry) => !entry.linked)
            .map((entry) => ({ value: entry.name, label: entry.name }))}
          onChange={setBranch}
          disabled={!canLink || busy}
        />
        <Button
          label={t("Link branch")}
          disabled={!canLink || busy || !branch}
          onPress={() => void associate(branch, "associate")}
        />
      </Disclosure>
    </>
  );
}

export function IssueCreateScreen({ route }: StaticScreenProps<Target>) {
  const t = useUiTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  return (
    <SettingsScreen title={t("New issue")}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <IssueCreateFormBody
          environmentId={route.params.environmentId}
          projectId={route.params.projectId}
          provider={route.params.provider}
          initialScope={route.params.scope}
          allowProjectChange
          onCreated={(target, id) =>
            navigation.dispatch(StackActions.replace("IssueDetail", { ...target, id }))
          }
        />
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function IssueCreateFormBody({
  environmentId,
  projectId: initialProjectId,
  provider: initialProvider,
  initialScope,
  allowProjectChange,
  onBusyChange,
  onCreated,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  provider: IssueProvider;
  initialScope?: string;
  allowProjectChange: boolean;
  onBusyChange?: (busy: boolean) => void;
  onCreated: (target: Target, id: string) => void;
}) {
  const t = useUiTranslation();
  const [selectedScope, setSelectedScope] = useState(initialScope ?? "");
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && !project.isScratch,
  );
  const [projectId, setProjectId] = useState(initialProjectId);
  const [selectedProvider, setProvider] = useState<IssueProvider | null>(
    allowProjectChange ? null : initialProvider,
  );
  const config = useEnvironmentServerConfig(environmentId);
  const sources = useEnvironmentQuery(
    sourceControlEnvironment.issueSources({
      environmentId,
      input: { projectIds: [projectId] },
    }),
  );
  const availableSources =
    sources.data?.[0]?.sources.filter(
      (source) =>
        source.provider !== "meituan" || isMeituanServiceEnabled(config?.settings, "requirements"),
    ) ?? [];
  const availableProviders = [...new Set(availableSources.map((source) => source.provider))];
  const platformSelected =
    !allowProjectChange ||
    availableProviders.length === 1 ||
    (selectedProvider !== null && availableProviders.includes(selectedProvider));
  const provider = !allowProjectChange
    ? initialProvider
    : availableProviders.length === 1
      ? availableProviders[0]!
      : (selectedProvider ?? initialProvider);
  const scopes =
    availableSources
      .filter((source) => source.provider === provider)
      .map((source) => source.scope) ?? [];
  const scope = scopes.includes(selectedScope) ? selectedScope : scopes[0];
  const target: Target = { environmentId, projectId, provider, ...(scope ? { scope } : {}) };
  const [type, setType] = useState<(typeof IssueMetadataInput.Type)["type"]>("REQUIREMENT");
  const [subtype, setSubtype] = useState("");
  const [title, setTitle] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const allowed = useAtomValue(
    sourceControlEnvironment.createIssue.permissionAtom(target.environmentId),
  );
  const command = useAtomCommand(sourceControlEnvironment.createIssue, { reportFailure: false });
  const metadata = useEnvironmentQuery(
    scope && platformSelected
      ? sourceControlEnvironment.issueMetadata({
          environmentId: target.environmentId,
          input: { ...target, type, subtype, query: personQuery },
        })
      : null,
  );
  const people = useEnvironmentQuery(
    scope && platformSelected
      ? sourceControlEnvironment.issuePeople({
          environmentId: target.environmentId,
          input: { ...target, query: personQuery },
        })
      : null,
  );
  const submit = async () => {
    if (!scope || generating || !platformSelected) return;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    const result = await command({
      environmentId: target.environmentId,
      input: {
        ...target,
        title,
        body,
        type,
        subtype,
        assignees: assignee ? [assignee] : [],
        fields,
      },
    });
    setBusy(false);
    onBusyChange?.(false);
    if (result._tag === "Success") onCreated(target, result.value.id);
    else {
      const failure = squashAtomCommandFailure(result);
      setError(
        isIssueError(failure)
          ? [t(failure.message), ...(failure.fields ?? []).map((field) => field.message)].join("\n")
          : failure instanceof Error
            ? t(failure.message)
            : t("Could not create issue."),
      );
      if (
        failure &&
        typeof failure === "object" &&
        "reason" in failure &&
        failure.reason === "outcome-unknown"
      )
        setUncertain(true);
    }
  };
  return (
    <>
      {allowProjectChange ? (
        <IssuePicker
          label={t("Project")}
          value={projectId}
          options={projects.map((project) => ({ value: project.id, label: project.title }))}
          disabled={busy || generating}
          onChange={(value) => {
            setProjectId(ProjectId.make(value));
            setProvider(null);
            setAssignee("");
            setPersonQuery("");
            setSelectedScope("");
            setSubtype("");
            setFields({});
          }}
        />
      ) : null}
      {allowProjectChange && availableProviders.length > 1 ? (
        <IssuePicker
          label={t("Choose platform")}
          value={selectedProvider ?? ""}
          options={availableProviders.map((value) => ({
            value,
            label: value === "github" ? t("GitHub Issues") : t("MEP ONES"),
          }))}
          disabled={busy || generating}
          onChange={(value) => {
            setProvider(value === "github" ? "github" : "meituan");
            setAssignee("");
            setPersonQuery("");
            setSelectedScope("");
            setSubtype("");
            setFields({});
          }}
        />
      ) : null}
      <DraftFillButton
        environmentId={target.environmentId}
        projectId={target.projectId}
        context={[title, body].filter(Boolean).join("\n\n")}
        disabled={busy || uncertain}
        onBusyChange={setGenerating}
        onDraft={(draft) => {
          setTitle(draft.title);
          setBody(
            [
              draft.description,
              draft.constraints.length
                ? t("Constraints") + "\n" + draft.constraints.map((line) => "- " + line).join("\n")
                : "",
              draft.acceptanceCriteria.length
                ? t("Acceptance criteria") +
                  "\n" +
                  draft.acceptanceCriteria.map((line) => "- " + line).join("\n")
                : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
          );
        }}
      />
      {scopes.length > 1 ? (
        <IssuePicker
          label={t("MEP space ID")}
          value={scope ?? ""}
          options={scopes.map((value) => ({ value, label: value }))}
          onChange={(value) => {
            setSelectedScope(value);
            setAssignee("");
            setPersonQuery("");
            setSubtype("");
            setFields({});
          }}
        />
      ) : null}
      {target.provider === "meituan" ? (
        <>
          <IssuePicker
            label={t("Work item type")}
            value={type}
            options={[
              { value: "REQUIREMENT", label: t("Requirement") },
              { value: "DEVTASK", label: t("Task") },
              { value: "DEFECT", label: t("Defect") },
            ]}
            onChange={(value) => {
              setType(value as typeof type);
              setSubtype("");
              setFields({});
            }}
          />
          <IssuePicker
            label={t("Subtype")}
            value={subtype}
            options={metadata.data?.subtypes ?? []}
            onChange={(value) => {
              setSubtype(value);
              setFields({});
            }}
          />
        </>
      ) : null}
      <AppTextInput
        accessibilityLabel={t("Title")}
        placeholder={t("Title")}
        value={title}
        onChangeText={setTitle}
        editable={!busy && !generating}
        maxLength={256}
      />
      <AppTextInput
        accessibilityLabel={t("Description")}
        placeholder={t("Description")}
        multiline
        value={body}
        onChangeText={setBody}
        editable={!busy && !generating}
      />
      <AppTextInput
        accessibilityLabel={t("Search people")}
        placeholder={t("Search people")}
        onSubmitEditing={(event) => setPersonQuery(event.nativeEvent.text)}
        returnKeyType="search"
        editable={!busy && !generating}
      />
      <IssuePicker
        label={t("Assignee")}
        value={assignee}
        options={[{ value: "", label: t("Unassigned") }, ...(people.data ?? [])]}
        onChange={setAssignee}
        disabled={busy || generating}
      />
      {metadata.data?.fields.map((field) => (
        <View key={field.variable} className="gap-2">
          <Text>
            {field.label}
            {field.required ? " *" : ""}
          </Text>
          {field.options.length && field.multiple ? (
            field.options.map((option) => (
              <ListToggleRow
                key={option.value}
                label={option.label}
                disabled={busy || generating}
                value={(fields[field.variable] ?? "").split(",").includes(option.value)}
                onValueChange={(checked) => {
                  const selected = (fields[field.variable] ?? "")
                    .split(",")
                    .filter(Boolean)
                    .filter((value) => value !== option.value);
                  setFields({
                    ...fields,
                    [field.variable]: [...selected, ...(checked ? [option.value] : [])].join(","),
                  });
                }}
              />
            ))
          ) : field.options.length ? (
            <IssuePicker
              label={field.label}
              value={fields[field.variable] ?? ""}
              options={field.options}
              onChange={(value) => setFields({ ...fields, [field.variable]: value })}
              disabled={busy || generating}
            />
          ) : (
            <AppTextInput
              accessibilityLabel={field.label}
              value={fields[field.variable] ?? ""}
              onChangeText={(value) => setFields({ ...fields, [field.variable]: value })}
              editable={!busy && !generating}
            />
          )}
        </View>
      ))}
      {error || metadata.error ? (
        <Text className="text-danger">{error ?? metadata.error}</Text>
      ) : null}
      <Button
        label={t("Create issue")}
        icon="plus"
        loading={busy}
        disabled={
          generating ||
          !platformSelected ||
          !allowed ||
          !title.trim() ||
          uncertain ||
          metadata.isPending ||
          Boolean(metadata.error) ||
          metadata.data?.fields.some(
            (field) => field.required && !fields[field.variable]?.trim(),
          ) ||
          (target.provider === "meituan" && !subtype)
        }
        onPress={() => void submit()}
      />
    </>
  );
}

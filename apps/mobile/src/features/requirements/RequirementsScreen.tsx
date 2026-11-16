import { StackActions, useNavigation } from "@react-navigation/native";
import type { StaticScreenProps } from "@react-navigation/native";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  IssueError,
  BranchIssueError,
  type IssueProvider,
  type IssueMetadataInput,
  CommandId,
  type WorkItemCommandInput,
  type WorkItemId,
  type WorkItemSource,
  type ThreadId,
} from "@t3tools/contracts";
import { useContext, useRef, useState } from "react";
import * as Schema from "effect/Schema";
import { Keyboard, Linking, View, Pressable, ScrollView } from "react-native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
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
import { ProjectTag, Disclosure, useRequirementGroups } from "./RequirementPrimitives";
import { DraftFillButton } from "./DraftFillButton";
import { Menu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import {
  DELIVERY_PROGRESS_LABELS,
  REQUIREMENT_GROUPS,
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
import {
  TaskEditor,
  TaskDetail,
  CandidateCard,
  type WorkItemsRouteParams,
} from "../work-items/WorkItemsScreen";

type Target = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  provider: IssueProvider;
  scope?: string;
};
const isBranchIssueError = Schema.is(BranchIssueError);
const isIssueError = Schema.is(IssueError);

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
      <Text>{t("Connect an environment and add a project to use the task board.")}</Text>
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
  const [source, setSource] = useState<RequirementSource>("all");
  const [projectId, setProjectId] = useState<ProjectId | null>(
    initial?.projectId ?? sourceThread?.projectId ?? null,
  );
  const [assignee, setAssignee] = useState("me");
  const [queryText, setQueryText] = useState("");
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [view, setView] = useState<"list" | "board">("list");
  const [pagination, setPagination] = useState<{ key: string; pages: RequirementPagination }>({
    key: "",
    pages: {},
  });
  const environmentIds = visibleEnvironments.map((environment) => environment.environmentId);
  const permissions = useAtomValue(permissionAtoms(environmentIds));
  const filterKey = JSON.stringify([environmentIds, source, projectId, assignee, query, archived]);
  if (pagination.key !== filterKey) setPagination({ key: filterKey, pages: {} });
  const config = useEnvironmentServerConfig(environmentId);
  const data = useAtomValue(
    boardAtoms(
      new RequirementOverviewKey({
        environmentIds,
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
  const projectKey = (project: { environmentId: EnvironmentId; id: ProjectId }) =>
    `${project.environmentId}/${project.id}`;
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
        title: initial.sourceTitle ?? sourceThread?.title ?? "Chat",
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
  const listOffset = useRef(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const showItem = (id: WorkItemId) => {
    setScrollOffset(0);
    setSelectedId(id);
  };
  const back = () => {
    setCreating(null);
    setSelectedId(null);
    setScrollOffset(listOffset.current);
  };
  useHardwareBack(workspace, () => {
    if (Keyboard.isVisible()) Keyboard.dismiss();
    else if (!busy) {
      if (creating || selectedId) back();
      else selectTab("threads");
    }
    return true;
  });
  const refresh = () => {
    for (const atom of data.atoms) registry.refresh(atom);
  };
  const run = async (input: WorkItemCommandInput) => {
    if (pending.current || !canOperate) return null;
    const request = prepareWorkItemCommandRetry(input, retries.current);
    pending.current = true;
    setBusy(true);
    const response = await mutate({ environmentId, input: request.input }).finally(() => {
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
  const scan = async (
    target: { environmentId: EnvironmentId; projectId: ProjectId },
    dismissThreadId?: ThreadId,
  ) => {
    if (
      pending.current ||
      !registry.get(serverEnvironment.discoverWorkItems.permissionAtom(target.environmentId)) ||
      registry.get(serverEnvironment.configValueAtom(target.environmentId))?.workItemDiscovery !==
        true
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
    setScrollOffset(0);
    setCreating({ projectId: target.projectId, ...(source ? { source } : {}), description });
  };
  const open = (entry: EnvironmentRequirementEntry) => {
    if (entry.kind === "local") {
      setActionEnvironmentId(entry.environmentId);
      showItem(entry.item.id);
    } else
      navigation.navigate("IssueDetail", {
        environmentId: entry.environmentId,
        projectId: entry.projectId,
        provider: entry.provider,
        id: entry.issue.id,
        scope: entry.scope,
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
          ? "gap-2 rounded-lg border border-border-subtle p-3"
          : "gap-2 border-b border-border-subtle py-3"
      }
    >
      <View className="flex-row items-start gap-3">
        <Text className="min-w-0 flex-1 text-base font-t3-medium">{entry.title}</Text>
        {entry.priority ? (
          <Text className="text-xs text-foreground-muted">{entry.priority}</Text>
        ) : null}
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <View
          className="max-w-48 flex-row items-center gap-1 rounded border border-border-subtle px-1.5 py-0.5"
          accessibilityLabel={`${t("Environment")}: ${environmentLabel(entry.environmentId)}`}
        >
          <SymbolView name="server.rack" size={12} tintColorClassName="accent-foreground-muted" />
          <Text numberOfLines={1} className="min-w-0 shrink text-xs text-foreground-muted">
            {environmentLabel(entry.environmentId)}
          </Text>
        </View>
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
            : `${entry.provider === "github" ? "GitHub" : "ONES"} #${entry.issue.id}`}
        </Text>
        {entry.kind === "local" ? (
          <Text className="text-xs text-foreground-muted">
            {entry.item.activeExecutionCount} {t("Active agents")}
          </Text>
        ) : (
          <Text className="text-xs text-foreground-muted">
            {entry.issue.assignees.map((person) => person.label).join(", ") || t("Unassigned")}
          </Text>
        )}
      </View>
      <View className="flex-row flex-wrap items-center gap-3">
        {entry.summary && entry.summary.requiredPullRequests > 0 ? (
          <Text className="text-xs text-foreground-muted">
            PR {entry.summary.mergedPullRequests}/{entry.summary.requiredPullRequests}
          </Text>
        ) : null}
        <Text
          className={
            entry.group === "attention" ? "text-xs text-danger" : "text-xs text-foreground-muted"
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
    </Pressable>
  );
  const renderGroup = (group: (typeof REQUIREMENT_GROUPS)[number]) => {
    const rows = entries.filter((entry) => entry.group === group.key);
    if (!rows.length) return null;
    return (
      <View key={group.key} style={view === "board" ? { width: 280 } : undefined}>
        <Disclosure
          title={t(group.label)}
          count={rows.length}
          open={!collapsed.includes(group.key)}
          onToggle={() => toggle(group.key)}
        >
          {rows.map(renderRow)}
        </Disclosure>
      </View>
    );
  };
  return (
    <SettingsScreen
      workspaceRoot={workspace}
      title={t("Requirements board")}
      actions={
        errors.length && !creating && !selectedId
          ? [
              {
                accessibilityLabel: t("View loading errors"),
                icon: "exclamationmark.triangle",
                onPress: () =>
                  Dialog.alert(t("Some requirements could not be loaded"), errors.join("\n\n")),
              },
            ]
          : undefined
      }
    >
      <ScreenScrollView
        key={creating ? "create" : (selectedId ?? "list")}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pb-12"
        contentOffset={{ x: 0, y: scrollOffset }}
        scrollEventThrottle={100}
        onScroll={(event) => {
          if (!creating && !selectedId) listOffset.current = event.nativeEvent.contentOffset.y;
        }}
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
            <View className="flex-row flex-wrap items-center justify-between gap-2">
              <IssuePicker
                label={t("Environment")}
                value={filterEnvironmentId ?? "all"}
                options={[
                  { value: "all", label: t("All environments") },
                  ...onlineEnvironments.map((environment) => ({
                    value: environment.environmentId,
                    label: environment.label,
                  })),
                ]}
                onChange={(value) => {
                  onEnvironment(value === "all" ? null : EnvironmentId.make(value));
                  setProjectId(null);
                }}
              />
              <Menu
                title={t("Scan chats")}
                actions={projects.map((project) => ({
                  id: projectKey(project),
                  title: `${environmentLabel(project.environmentId)} · ${project.title}`,
                  attributes: {
                    disabled:
                      busy ||
                      !permissions.get(project.environmentId)?.discoverWorkItems ||
                      registry.get(serverEnvironment.configValueAtom(project.environmentId))
                        ?.workItemDiscovery !== true,
                  },
                }))}
                onPressAction={({ nativeEvent }) => {
                  const project = projects.find(
                    (project) => projectKey(project) === nativeEvent.event,
                  );
                  if (project)
                    void scan({ environmentId: project.environmentId, projectId: project.id });
                }}
              >
                <Button
                  label={t("Scan chats")}
                  tone="secondary"
                  onPress={() => {}}
                  disabled={!projects.length || busy}
                />
              </Menu>
              <Button
                label={t("Requirement settings")}
                tone="text"
                onPress={() => navigation.navigate("SettingsRequirements")}
              />
            </View>
            <View className="flex-row items-center gap-1">
              <View className="min-w-0 flex-1">
                <AppTextInput
                  accessibilityLabel={t("Search title or number")}
                  placeholder={t("Search title or number")}
                  value={queryText}
                  onChangeText={setQueryText}
                  onSubmitEditing={() => setQuery(queryText)}
                  returnKeyType="search"
                />
              </View>
              <Menu
                title={t("Filters")}
                actions={[
                  {
                    id: "source",
                    title: t("Issue source"),
                    subactions: [
                      {
                        id: "source:all",
                        title: t("All sources"),
                        state: source === "all" ? "on" : "off",
                      },
                      {
                        id: "source:meituan",
                        title: "MEP ONES",
                        state: source === "meituan" ? "on" : "off",
                      },
                      {
                        id: "source:github",
                        title: "GitHub Issues",
                        state: source === "github" ? "on" : "off",
                      },
                      {
                        id: "source:local",
                        title: t("Local work items"),
                        state: source === "local" ? "on" : "off",
                      },
                    ],
                  },
                  {
                    id: "project",
                    title: t("Project"),
                    subactions: [
                      {
                        id: "project:",
                        title: t("All projects"),
                        state: !projectId ? ("on" as const) : ("off" as const),
                      },
                      ...projects.map((project) => ({
                        id: `project:${projectKey(project)}`,
                        title: `${environmentLabel(project.environmentId)} · ${project.title}`,
                        state:
                          projectId === project.id &&
                          (filterEnvironmentId ?? fallbackEnvironmentId) === project.environmentId
                            ? ("on" as const)
                            : ("off" as const),
                      })),
                    ],
                  },
                  ...(source !== "local"
                    ? [
                        {
                          id: "assignee",
                          title: t("Assignee"),
                          subactions: [
                            { value: "me", label: t("Assigned to me") },
                            { value: "all", label: t("All assignees") },
                            { value: "unassigned", label: t("Unassigned") },
                            ...people.filter(
                              (person) => !["me", "all", "unassigned"].includes(person.value),
                            ),
                          ].map((person) => ({
                            id: `assignee:${person.value}`,
                            title: person.label,
                            state: assignee === person.value ? ("on" as const) : ("off" as const),
                          })),
                        },
                      ]
                    : []),
                  { id: "archived", title: t("Show archived"), state: archived ? "on" : "off" },
                  { id: "refresh", title: t("Refresh issues") },
                ]}
                onPressAction={({ nativeEvent }) => {
                  const id = nativeEvent.event;
                  if (id.startsWith("project:")) {
                    const project = projects.find((project) => projectKey(project) === id.slice(8));
                    setProjectId(project?.id ?? null);
                    if (project) onEnvironment(project.environmentId);
                  }
                  if (id.startsWith("source:")) {
                    setSource(id.slice(7) as RequirementSource);
                    setAssignee("me");
                  }
                  if (id.startsWith("assignee:")) setAssignee(id.slice(9));
                  if (id === "archived") setArchived(!archived);
                  if (id === "refresh") refresh();
                }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("Filters")}
                  className="size-12 items-center justify-center"
                >
                  <SymbolView
                    name="line.3.horizontal.decrease"
                    size={22}
                    tintColorClassName="accent-foreground"
                  />
                </Pressable>
              </Menu>
              <Menu
                title={t("View")}
                actions={[
                  { id: "list", title: t("List view"), state: view === "list" ? "on" : "off" },
                  { id: "board", title: t("Board view"), state: view === "board" ? "on" : "off" },
                ]}
                onPressAction={({ nativeEvent }) =>
                  setView(nativeEvent.event === "board" ? "board" : "list")
                }
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("View")}
                  className="size-12 items-center justify-center"
                >
                  <SymbolView
                    name={view === "list" ? "list.number" : "square.grid.2x2"}
                    size={22}
                    tintColorClassName="accent-foreground"
                  />
                </Pressable>
              </Menu>
              <Menu
                title={t("New")}
                actions={(["meituan", "github", "local"] as const).map((provider) => ({
                  id: provider,
                  title:
                    provider === "local"
                      ? t("Local work item")
                      : provider === "github"
                        ? "GitHub Issue"
                        : "MEP ONES",
                  subactions: projects.map((project) => ({
                    id: `${provider}:${projectKey(project)}`,
                    title: `${environmentLabel(project.environmentId)} · ${project.title}`,
                    attributes: {
                      disabled:
                        provider === "local"
                          ? !permissions.get(project.environmentId)?.mutateWorkItem ||
                            registry.get(serverEnvironment.configValueAtom(project.environmentId))
                              ?.workItems !== true
                          : !permissions.get(project.environmentId)?.createIssue,
                    },
                  })),
                }))}
                onPressAction={({ nativeEvent }) => {
                  const id = nativeEvent.event;
                  const provider = id.slice(0, id.indexOf(":"));
                  const project = projects.find(
                    (project) => projectKey(project) === id.slice(id.indexOf(":") + 1),
                  );
                  if (!project) return;
                  if (provider === "local")
                    createLocal({ environmentId: project.environmentId, projectId: project.id });
                  else if (provider === "github" || provider === "meituan")
                    navigation.navigate("IssueCreate", {
                      environmentId: project.environmentId,
                      projectId: project.id,
                      provider,
                    });
                }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("New")}
                  className="size-12 items-center justify-center"
                >
                  <SymbolView name="plus" size={22} tintColorClassName="accent-foreground" />
                </Pressable>
              </Menu>
            </View>
            <Text className="text-xs text-foreground-muted">
              {source === "all"
                ? t("All sources")
                : source === "local"
                  ? t("Local work items")
                  : source === "github"
                    ? "GitHub Issues"
                    : "MEP ONES"}{" "}
              · {projects.find((project) => project.id === projectId)?.title ?? t("All projects")}
              {archived ? ` · ${t("Show archived")}` : ""}
            </Text>
            {data.isPending && !entries.length ? (
              <Text>{t("Loading...")}</Text>
            ) : !entries.length && errors.length ? (
              <View className="gap-3">
                <Text className="text-foreground-muted">
                  {t("Some requirements could not be loaded")}
                </Text>
                <Button label={t("Retry")} onPress={refresh} />
              </View>
            ) : !entries.length ? (
              <Text className="text-foreground-muted">{t("No matching work items.")}</Text>
            ) : null}
            {data.isPending && entries.length ? (
              <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
                {t("Updating")}
              </Text>
            ) : null}
            {view === "list" ? (
              REQUIREMENT_GROUPS.map(renderGroup)
            ) : (
              <ScrollView
                horizontal
                contentContainerStyle={{ gap: 20 }}
                showsHorizontalScrollIndicator
              >
                {REQUIREMENT_GROUPS.map(renderGroup)}
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
              <View className="gap-3">
                <Text className="text-sm font-t3-semibold">{t("Discovered tasks")}</Text>
                {data.candidates.map((candidate) => (
                  <View key={`${candidate.environmentId}:${candidate.id}`} className="gap-2">
                    <Text className="text-xs text-foreground-muted">
                      {environmentLabel(candidate.environmentId)}
                    </Text>
                    <CandidateCard
                      candidate={candidate}
                      disabled={!permissions.get(candidate.environmentId)?.mutateWorkItem || busy}
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
                    />
                  </View>
                ))}
              </View>
            ) : null}
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

export function IssueDetailScreen({ route }: StaticScreenProps<Target & { id: string }>) {
  const t = useUiTranslation();
  const target = route.params;
  const { environmentId } = target;
  const result = useEnvironmentQuery(
    sourceControlEnvironment.issueDetail({ environmentId, input: target }),
  );
  const tracking = useEnvironmentQuery(
    result.data
      ? serverEnvironment.workItemsLive({ environmentId, input: { issueUrl: result.data.url } })
      : null,
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
  const branches = useEnvironmentQuery(
    project && result.data
      ? sourceControlEnvironment.issueBranches({
          environmentId,
          input: { cwd: project.workspaceRoot, url: result.data.url },
        })
      : null,
  );
  const link = useAtomCommand(sourceControlEnvironment.updateBranchIssues);
  const canLink = useAtomValue(
    sourceControlEnvironment.updateBranchIssues.permissionAtom(environmentId),
  );
  const [branch, setBranch] = useState("");
  const update = async () => {
    if (!state) return;
    setBusy(true);
    await command({ environmentId, input: { ...target, state } });
    setBusy(false);
    result.refresh();
  };
  const associate = async (name: string, action: "associate" | "disassociate") => {
    if (!project || !result.data) return;
    setBusy(true);
    await link({
      environmentId,
      input: { cwd: project.workspaceRoot, branch: name, action, urls: [result.data.url] },
    });
    setBusy(false);
    branches.refresh();
  };
  return (
    <SettingsScreen title={t("Issue details")}>
      <ScreenScrollView className="flex-1" contentContainerClassName="gap-5 px-5 pb-12">
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
            {tracking.data?.item ? (
              <RequirementDeliveryPanel
                environmentId={environmentId}
                item={tracking.data.item}
                summary={tracking.data.items[0]?.deliverySummary}
                transitions={result.data.transitions}
              />
            ) : null}
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
            <Disclosure title={t("Linked branches")}>
              <Text className="text-xs text-foreground-muted">
                {t(target.provider === "meituan" ? "Synced with MEP" : "Only in this environment")}
              </Text>
              {branches.error ? (
                <Text className="text-danger">
                  {isBranchIssueError(branches.failure) &&
                  branches.failure.reason === "invalid-link"
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
            <Button
              label={t("View original")}
              icon="arrow.up.right"
              onPress={() => void Linking.openURL(result.data!.url)}
            />
          </>
        ) : (
          <Text>{t("Loading...")}</Text>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

export function IssueCreateScreen({ route }: StaticScreenProps<Target>) {
  const t = useUiTranslation();
  const navigation = useNavigation();
  const [selectedScope, setSelectedScope] = useState("");
  const projects = useProjects().filter(
    (project) => project.environmentId === route.params.environmentId && !project.isScratch,
  );
  const [projectId, setProjectId] = useState(route.params.projectId);
  const [selectedProvider, setProvider] = useState<IssueProvider | null>(null);
  const sources = useEnvironmentQuery(
    sourceControlEnvironment.issueSources({
      environmentId: route.params.environmentId,
      input: { projectIds: [projectId] },
    }),
  );
  const availableProviders = [
    ...new Set(sources.data?.[0]?.sources.map((source) => source.provider) ?? []),
  ];
  const platformSelected =
    availableProviders.length === 1 ||
    (selectedProvider !== null && availableProviders.includes(selectedProvider));
  const provider =
    availableProviders.length === 1
      ? availableProviders[0]!
      : (selectedProvider ?? route.params.provider);
  const scopes =
    sources.data?.[0]?.sources
      .filter((source) => source.provider === provider)
      .map((source) => source.scope) ?? [];
  const scope = scopes.includes(selectedScope) ? selectedScope : scopes[0];
  const target = { ...route.params, projectId, provider, ...(scope ? { scope } : {}) };
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
    if (result._tag === "Success")
      navigation.dispatch(StackActions.replace("IssueDetail", { ...target, id: result.value.id }));
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
    <SettingsScreen title={t("New issue")}>
      <ScreenScrollView className="flex-1" contentContainerClassName="gap-4 px-5 pb-12">
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
        {availableProviders.length > 1 ? (
          <IssuePicker
            label={t("Choose platform")}
            value={selectedProvider ?? ""}
            options={availableProviders.map((value) => ({
              value,
              label: value === "github" ? "GitHub Issues" : "MEP ONES",
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
                  ? t("Constraints") +
                    "\n" +
                    draft.constraints.map((line) => "- " + line).join("\n")
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
      </ScreenScrollView>
    </SettingsScreen>
  );
}

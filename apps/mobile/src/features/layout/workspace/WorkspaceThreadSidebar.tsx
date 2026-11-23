import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Platform } from "react-native";
import { useEffect, useRef } from "react";
import { dispatchRootStackReset, rootStackState } from "../../../lib/root-stack-reset";
import { appAtomRegistry } from "../../../state/atom-registry";
import { useProjects, useQuietThreadShell } from "../../../state/entities";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../../state/preferences";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../../state/session";
import { environmentThreadShells } from "../../../state/threads";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../../state/workspace";
import { AndroidSidebarSpaceControls } from "./AndroidSidebarSpaceControls";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import {
  activeAndroidSidebarSpace,
  androidSidebarSpaceAnchor,
  androidSidebarSpaceScope,
  availableAndroidSidebarProjects,
  EMPTY_ANDROID_SIDEBAR_SPACES,
  type AndroidSidebarSpace,
  visibleAndroidWorkspaceThread,
} from "./android-sidebar-spaces";
import { useNavigation, useNavigationState } from "@react-navigation/native";

import { scopedThreadKey } from "../../../lib/scopedEntities";
import { uuidv4 } from "../../../lib/uuid";
import { HomeHumanActionInbox } from "../../home/HomeHumanActionInbox";
import { usePendingTaskListActions } from "../../home/usePendingTaskListActions";
import { useAdaptiveWorkspaceLayout, useWorkspacePaneState } from "../adaptive-workspace-context";
import { openSettings } from "../../settings/settings-navigation";
import { ThreadNavigationSidebar } from "../../threads/ThreadNavigationSidebar";
import { useOpenThreadPullRequests } from "../../threads/use-open-thread-pull-requests";
import { useSelectWorkspaceDetail } from "./useSelectWorkspaceDetail";

type Route = { readonly name: string; readonly params?: object };

const NONE: readonly { readonly environmentId: EnvironmentId }[] = [];

function selectedThreadRef(state: {
  readonly index: number;
  readonly routes: readonly Route[];
}): ScopedThreadRef | null {
  if (Platform.OS === "android") return visibleAndroidWorkspaceThread(state);
  const params = state.routes
    .slice(0, state.index + 1)
    .findLast((route) => route.name.startsWith("Thread"))?.params;
  if (
    !params ||
    !("environmentId" in params) ||
    !("threadId" in params) ||
    typeof params.environmentId !== "string" ||
    typeof params.threadId !== "string" ||
    !params.environmentId ||
    !params.threadId
  )
    return null;
  return {
    environmentId: EnvironmentId.make(params.environmentId),
    threadId: ThreadId.make(params.threadId),
  };
}

/** The thread list in the workspace's sidebar column. */
export function WorkspaceThreadSidebar() {
  const navigation = useNavigation();
  const { layout, setPrimarySidebarSearchQuery, revealPrimarySidebar, openWorkspaceTab } =
    useAdaptiveWorkspaceLayout();
  const { panes, primarySidebarSearchQuery } = useWorkspacePaneState();
  const selectDetail = useSelectWorkspaceDetail();
  const openThreadPullRequests = useOpenThreadPullRequests();
  const selectedRef = useNavigationState(selectedThreadRef);
  const selectedThread = selectedRef
    ? scopedThreadKey(selectedRef.environmentId, selectedRef.threadId)
    : null;
  const workspace = useWorkspaceTabs();
  const enabled = Platform.OS === "android" && layout.usesSplitView;
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const saved =
    enabled && AsyncResult.isSuccess(preferences)
      ? (preferences.value.androidSidebarSpaces ?? EMPTY_ANDROID_SIDEBAR_SPACES)
      : EMPTY_ANDROID_SIDEBAR_SPACES;
  const activeSpace = activeAndroidSidebarSpace(saved);
  const loadingSpaces = enabled && !AsyncResult.isSuccess(preferences);
  const projects = useProjects();
  const environments = useWorkspaceEnvironments();
  const readable = useEnvironmentsWithScope(
    enabled ? environments : NONE,
    AuthOrchestrationReadScope,
  );
  const available = availableAndroidSidebarProjects(
    projects,
    new Set(
      environments
        .filter(
          (environment) =>
            environment.isEnabled &&
            environment.connectionState === "connected" &&
            readable.has(environment.environmentId),
        )
        .map((environment) => environment.environmentId),
    ),
  );
  const scope = androidSidebarSpaceScope(activeSpace, available);
  const currentThread = useQuietThreadShell(enabled ? selectedRef : null);
  const currentThreadInScope =
    scope.kind === "space" &&
    currentThread !== null &&
    scope.projectRefs.some(
      (ref) =>
        ref.environmentId === currentThread.environmentId &&
        ref.projectId === currentThread.projectId,
    );
  const previousRoute = useRef<string | null>(null);
  const selectThreadRoute = (params: ReactNavigation.RootParamList["Thread"]) =>
    selectDetail({ name: "Thread", params });
  const { openPendingTask } = usePendingTaskListActions(selectThreadRoute);
  const rememberThread = (space: AndroidSidebarSpace, target: ScopedThreadRef) => {
    if (
      space.lastThread?.threadId === target.threadId &&
      space.lastThread.environmentId === target.environmentId
    )
      return;
    void savePreferences({
      transform: (current) => {
        const state = current.androidSidebarSpaces ?? EMPTY_ANDROID_SIDEBAR_SPACES;
        if (state.selectedId !== space.id) return {};
        return {
          androidSidebarSpaces: {
            ...state,
            spaces: state.spaces.map((item) =>
              item.id === space.id ? { ...item, lastThread: target } : item,
            ),
          },
        };
      },
    });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Record a navigated real thread, never a draft or a temporary outside-Space reveal.
  useEffect(() => {
    if (!enabled || selectedThread === previousRoute.current) return;
    if (selectedRef && !currentThread) return;
    previousRoute.current = selectedThread;
    if (activeSpace && selectedRef && currentThreadInScope && currentThread?.archivedAt === null) {
      rememberThread(activeSpace, selectedRef);
    }
  });

  const showSpaceRoute = (space: AndroidSidebarSpace | null) => {
    if (activeSpace?.id !== space?.id) setPrimarySidebarSearchQuery("");
    const anchor = space
      ? androidSidebarSpaceAnchor(space, available, (ref) =>
          appAtomRegistry
            .get(environmentThreadShells.environmentThreadIndexAtom(ref.environmentId))
            .get(ref.threadId),
        )
      : null;
    if (anchor !== null) {
      selectThreadRoute({ environmentId: anchor.environmentId, threadId: anchor.threadId });
      return;
    }
    // Don't call openWorkspaceTab: its global last selection can be outside this Space.
    const state = rootStackState(navigation);
    const home = state?.routes.find((route) => route.name === "Home");
    if (state && home) {
      workspace?.dispatch({ type: "select", tab: "threads" });
      dispatchRootStackReset(navigation, state, { ...state, routes: [home], index: 0 });
      revealPrimarySidebar();
    }
  };

  const spaceControls =
    enabled && !loadingSpaces ? (
      <AndroidSidebarSpaceControls
        spaces={saved.spaces}
        selected={activeSpace}
        available={available}
        selectedThreadOutsideSpace={
          selectedRef !== null && currentThread !== null && !currentThreadInScope
        }
        onSelect={(space) => {
          void savePreferences({
            transform: (current) => ({
              androidSidebarSpaces: {
                ...(current.androidSidebarSpaces ?? EMPTY_ANDROID_SIDEBAR_SPACES),
                selectedId: space?.id ?? null,
              },
            }),
          });
          showSpaceRoute(space);
        }}
        onSave={(input, previous) => {
          const next = { ...previous, ...input, id: previous?.id ?? uuidv4() };
          void savePreferences({
            transform: (current) => {
              const state = current.androidSidebarSpaces ?? EMPTY_ANDROID_SIDEBAR_SPACES;
              return {
                androidSidebarSpaces: {
                  selectedId: next.id,
                  spaces: previous
                    ? state.spaces.map((space) => (space.id === next.id ? next : space))
                    : [...state.spaces, next],
                },
              };
            },
          });
          showSpaceRoute(next);
        }}
        onDelete={(space) => {
          void savePreferences({
            transform: (current) => {
              const state = current.androidSidebarSpaces ?? EMPTY_ANDROID_SIDEBAR_SPACES;
              return {
                androidSidebarSpaces: {
                  selectedId: null,
                  spaces: state.spaces.filter((item) => item.id !== space.id),
                },
              };
            },
          });
          showSpaceRoute(null);
        }}
      />
    ) : undefined;
  const canDraftInProject = (environmentId: EnvironmentId, projectId: string) =>
    !loadingSpaces &&
    (scope.kind === "all" ||
      (scope.projectRefs.some(
        (ref) => ref.environmentId === environmentId && ref.projectId === projectId,
      ) &&
        readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)));
  return (
    <ThreadNavigationSidebar
      width={layout.listPaneWidth ?? 0}
      visible={panes.primarySidebarVisible}
      onRequestVisibility={revealPrimarySidebar}
      selectedThreadKey={selectedThread}
      spaceScope={scope}
      spaceControls={spaceControls}
      inboxEntry={
        enabled && panes.primarySidebarVisible ? (
          <HomeHumanActionInbox
            onOpenTarget={(target) =>
              selectThreadRoute({
                environmentId: target.environmentId,
                threadId: target.threadId,
                pendingHumanAction: { ...target, activation: uuidv4() },
              })
            }
          />
        ) : undefined
      }
      spacePreferencesLoading={loadingSpaces}
      onOpenSettings={() => openWorkspaceTab("settings")}
      onOpenEnvironmentSettings={() => openSettings(navigation, "SettingsEnvironments")}
      onNewThreadInProject={(project: EnvironmentProject) => {
        if (!canDraftInProject(project.environmentId, project.id)) return;
        selectThreadRoute({
          draft: {
            requestId: uuidv4(),
            environmentId: String(project.environmentId),
            projectId: String(project.id),
            title: project.title,
          },
        });
      }}
      onNewThreadOnBranch={(thread: EnvironmentThreadShell) => {
        if (!canDraftInProject(thread.environmentId, thread.projectId)) return;
        selectThreadRoute({
          draft: {
            requestId: uuidv4(),
            environmentId: String(thread.environmentId),
            projectId: String(thread.projectId),
            branch: thread.branch,
            worktreePath: thread.worktreePath,
          },
        });
      }}
      onOpenPendingTask={openPendingTask}
      onSelectThread={(thread) =>
        selectThreadRoute({
          environmentId: String(thread.environmentId),
          threadId: String(thread.id),
        })
      }
      onOpenThreadPullRequests={openThreadPullRequests}
      onSearchQueryChange={setPrimarySidebarSearchQuery}
      searchQuery={primarySidebarSearchQuery}
    />
  );
}

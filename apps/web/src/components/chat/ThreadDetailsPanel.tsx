import type { EditorId } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ProjectId } from "@t3tools/contracts";
import type { ProjectScript } from "@t3tools/contracts";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import type { ThreadId } from "@t3tools/contracts";
import type { WorkspaceRootId } from "@t3tools/contracts";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import type { DraftId } from "../../composerDraftStore";
import type { EnvMode } from "../BranchToolbar.logic";
import type { EnvironmentOption } from "../BranchToolbar.logic";
import type { NewProjectScriptInput } from "../ProjectScriptsControl";
import type { ProjectScriptActionResult } from "../ProjectScriptsControl";
import type { ThreadDetailsUsageInput } from "./ThreadDetailsUsage";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { WorkspaceRecoveryControl } from "./WorkspaceRecoveryControl";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { useDiffPanelStore } from "../../diffPanelStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadTerminalActions } from "../terminal/useThreadTerminalActions";
import { RepositoryDetails } from "./RepositoryDetails";
import { BranchIssuesPanel } from "./BranchIssuesPanel";
import { GroupedBranchIssuesPanel } from "./GroupedBranchIssuesPanel";
import { BranchIssueAssociationProvider } from "./branchIssueAssociation";

import { isScratchProject } from "@t3tools/client-runtime/state/projects";

import { useT3ProjectFileScripts } from "../../hooks/useT3ProjectFileScripts";

import { BranchToolbar } from "../BranchToolbar";
import BaseGitActionsControl from "../GitActionsControl";
import ProjectScriptsControl from "../ProjectScriptsControl";
import { memo, useState, type ComponentProps } from "react";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { ThreadServersPanel } from "./ThreadServersPanel";
import { ThreadDetailsContext, ThreadDetailsUsage } from "./ThreadDetailsUsage";
import { ThreadDetailsItemsMenuItems } from "./ThreadDetailsItemsMenu";
import { resolveThreadDetailsVisibility, THREAD_DETAILS_ITEMS } from "./threadDetailsItems";
import { useClientSettings } from "../../hooks/useSettings";
import { useServerConfigs } from "../../state/entities";
import { ThreadDetailsThreadPrRows } from "./ThreadDetailsPrRows";
import { cn } from "../../lib/utils";
import { SlidersHorizontalIcon } from "lucide-react";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";
import { Menu, MenuPopup } from "../ui/menu";

const GitActionsControl = memo(BaseGitActionsControl);

interface ThreadDetailsPanelProps extends Pick<
  ComponentProps<typeof ThreadDetailsCard>,
  "anchor" | "handle"
> {
  forceNewWorktree?: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
  worktreePath: string | null;
  isServerThread: boolean;
  draftId?: DraftId;
  composerDraftTarget: ComposerThreadTarget;
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  openInShortcutEnabled: boolean;
  gitCwd: string | null;
  workspaceMutationId: string | null;
  isGitRepo: boolean;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  onEnvModeChange: (mode: EnvMode) => void;
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest: () => void;
  onOpenChanges?: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
  usage: ThreadDetailsUsageInput;
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  return (
    <BranchIssueAssociationProvider key={`${props.environmentId}:${props.threadId}`}>
      <ThreadDetailsPanelContents {...props} />
    </BranchIssueAssociationProvider>
  );
}

function ThreadDetailsPanelContents(props: ThreadDetailsPanelProps) {
  const t = useUiTranslation();
  const showTerminalButton = useClientSettings((settings) => settings.showRepositoryTerminalButton);
  const project = useProject({ environmentId: props.environmentId, projectId: props.projectId });
  const thread = useQuietThreadShell({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const workspace = thread?.workspace;
  const configuredRoots = (
    thread?.workspaceConfiguration ?? project?.workspaceConfig
  )?.roots.filter((root) => root.defaultSelected);
  const primaryResourceId = workspace?.bindings.find(
    (binding) => binding.rootId === workspace.primaryRootId,
  )?.resourceId;
  const [expandedRepository, setExpandedRepository] = useState<{
    environmentId: EnvironmentId;
    threadId: ThreadId;
    rootId: WorkspaceRootId | null;
  } | null>(null);
  const expandedResourceId =
    expandedRepository?.environmentId === props.environmentId &&
    expandedRepository.threadId === props.threadId
      ? expandedRepository.rootId === null
        ? null
        : (workspace?.bindings.find((binding) => binding.rootId === expandedRepository.rootId)
            ?.resourceId ?? primaryResourceId)
      : primaryResourceId;

  const visible = useClientSettings(resolveThreadDetailsVisibility);
  const issuesPlacement = useClientSettings((settings) => settings.branchIssuesPlacement);
  const showIssues = visible.issues && !(props.draftId && props.envMode === "worktree");
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const fileScripts = useT3ProjectFileScripts(
    props.environmentId,
    props.activeProjectScripts && visible.scripts ? props.gitCwd : null,
  );
  const activeThreadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const terminals = useThreadTerminalActions(workspace ? null : activeThreadRef);
  const serverConfig = useServerConfigs().get(props.environmentId);
  // A No project thread's folder sits inside the shared scratch root, so it must never get git.
  // Until the config and project load, a No project thread looks like any other folder.
  const offersGit =
    props.gitCwd !== null &&
    serverConfig !== undefined &&
    project !== null &&
    !isScratchProject(project, serverConfig.scratchWorkspaceRoot);
  const branchToolbarProps = {
    showGitControls: props.isGitRepo,
    environmentId: props.environmentId,
    threadId: props.threadId,
    projectId: props.projectId,
    worktreePath: props.worktreePath,
    isServerThread: props.isServerThread,
    ...(props.draftId ? { draftId: props.draftId } : {}),
    onEnvModeChange: props.onEnvModeChange,
    startFromOrigin: props.startFromOrigin,
    onStartFromOriginChange: props.onStartFromOriginChange,
    envMode: props.envMode,
    ...(props.activeThreadBranchOverride !== undefined
      ? { activeThreadBranchOverride: props.activeThreadBranchOverride }
      : {}),
    ...(props.onActiveThreadBranchOverrideChange
      ? { onActiveThreadBranchOverrideChange: props.onActiveThreadBranchOverrideChange }
      : {}),
    envLocked: props.envLocked,
    forceNewWorktree: props.forceNewWorktree ?? false,
    onComposerFocusRequest: props.onComposerFocusRequest,
    ...(props.onCheckoutPullRequestRequest
      ? { onCheckoutPullRequestRequest: props.onCheckoutPullRequestRequest }
      : {}),
  };

  return (
    <ThreadDetailsCard
      threadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
      anchor={props.anchor}
      handle={props.handle}
      supplementary={
        showIssues && issuesPlacement === "separate" ? (
          <GroupedBranchIssuesPanel
            key={`${props.environmentId}:${props.threadId}`}
            environmentId={props.environmentId}
            cwds={
              workspace
                ? workspace.resources.map((resource) => resource.checkoutRoot)
                : props.gitCwd
                  ? [props.gitCwd]
                  : []
            }
            currentCwd={props.gitCwd}
          />
        ) : null
      }
      contentKey={THREAD_DETAILS_ITEMS.filter((item) => visible[item.id])
        .map((item) => item.id)
        .join(",")}
      onContextMenu={(event) => {
        // Popups the card opens bubble here through React; they, fields, links, and selected text
        // keep their own menus.
        const target = event.target;
        const selection = window.getSelection();
        if (
          !(target instanceof Element) ||
          !event.currentTarget.contains(target) ||
          target.closest("input, textarea, [contenteditable], a[href]") ||
          (selection &&
            !selection.isCollapsed &&
            (event.currentTarget.contains(selection.anchorNode) ||
              event.currentTarget.contains(selection.focusNode)))
        )
          return;
        event.preventDefault();
        setMenuPosition({ x: event.clientX, y: event.clientY });
      }}
    >
      {(density) => {
        // Section flags follow the rows that will render, so no empty section steals the divider rule.
        const show = {
          environment: density === "full" && visible.environment,
          openIn:
            visible.openIn &&
            ((density !== "essential" && props.showOpenInPicker) ||
              (showTerminalButton && props.gitCwd !== null)),
          scripts: visible.scripts && props.activeProjectScripts !== undefined,
          branch: offersGit && props.isGitRepo && visible.branch,
          // Without a branch selector, linked pull requests still need somewhere to show.
          pullRequests: !(offersGit && props.isGitRepo) && visible.branch,
          git:
            offersGit &&
            props.activeProjectName !== undefined &&
            (visible.gitActions || (visible.changes && props.isGitRepo)),
        };
        return (
          <>
            <div className="group/details-items">
              {show.environment || show.openIn || show.scripts ? (
                <ThreadDetailsSection
                  headingId="thread-details-workspace-heading"
                  title="Workspace"
                  separated={false}
                  showHeading={false}
                >
                  <div className="flex flex-col">
                    {!workspace && configuredRoots && configuredRoots.length > 1 ? (
                      <div className="border-b border-border px-4 py-3 text-xs text-muted-foreground">
                        <p className="font-medium text-foreground">
                          {configuredRoots.map((root) => root.alias).join(" · ")}
                        </p>
                        <p className="mt-1">
                          {t(
                            props.envMode === "worktree"
                              ? "Creates one worktree per repository. The task starts when all repositories are ready."
                              : "This task uses all configured repositories in their current directories.",
                          )}
                        </p>
                      </div>
                    ) : null}
                    {show.environment ? (
                      <BranchToolbar
                        layout="panel"
                        panelSection="workspace"
                        availableEnvironments={props.availableEnvironments}
                        {...(props.onEnvironmentChange
                          ? { onEnvironmentChange: props.onEnvironmentChange }
                          : {})}
                        autoEnvironmentLabel={props.autoEnvironmentLabel}
                        onAutoEnvironment={props.onAutoEnvironment}
                        {...branchToolbarProps}
                      />
                    ) : null}

                    {show.openIn && !workspace ? (
                      <OpenInPicker
                        keybindings={props.keybindings}
                        environmentId={props.environmentId}
                        availableEditors={props.availableEditors}
                        openInCwd={props.gitCwd}
                        enableShortcut={props.openInShortcutEnabled}
                        displayMode="panel"
                        canOpenTerminal={terminals.canWrite()}
                        onOpenTerminal={
                          showTerminalButton && props.gitCwd
                            ? () => {
                                if (!props.gitCwd) return;
                                const launched = terminals.launchTerminal({
                                  location: {
                                    cwd: props.gitCwd,
                                    worktreePath: props.worktreePath,
                                  },
                                  place: (terminalId) =>
                                    useRightPanelStore
                                      .getState()
                                      .openTerminal(activeThreadRef, terminalId),
                                });
                                if (launched) void launched.result;
                              }
                            : undefined
                        }
                      />
                    ) : null}

                    {show.scripts && props.activeProjectScripts ? (
                      <ProjectScriptsControl
                        environmentId={props.environmentId}
                        displayMode="panel"
                        scripts={props.activeProjectScripts}
                        repositories={project?.workspaceConfig?.roots}
                        fileScripts={fileScripts}
                        preferredScriptId={props.preferredScriptId}
                        onRunScript={props.onRunProjectScript}
                        onAddScript={props.onAddProjectScript}
                        onUpdateScript={props.onUpdateProjectScript}
                        onDeleteScript={props.onDeleteProjectScript}
                      />
                    ) : null}
                  </div>
                </ThreadDetailsSection>
              ) : null}

              {workspace ? (
                workspace.resources.map((resource) => (
                  <RepositoryDetails
                    key={`${workspace.id}:${resource.id}`}
                    environmentId={props.environmentId}
                    threadId={props.threadId}
                    workspace={workspace}
                    resource={resource}
                    openInOptions={{
                      keybindings: props.keybindings,
                      availableEditors: props.availableEditors,
                      enableShortcut: props.openInShortcutEnabled,
                    }}
                    showOpenInPicker={show.openIn}
                    showBranch={visible.branch}
                    showActions={visible.gitActions}
                    showChanges={visible.changes}
                    expanded={expandedResourceId === resource.id}
                    onToggle={() =>
                      setExpandedRepository({
                        environmentId: props.environmentId,
                        threadId: props.threadId,
                        rootId:
                          expandedResourceId === resource.id
                            ? null
                            : (workspace.bindings.find(
                                (binding) => binding.resourceId === resource.id,
                              )?.rootId ?? workspace.primaryRootId),
                      })
                    }
                    onOpenChanges={() => {
                      useDiffPanelStore.getState().selectRepository(activeThreadRef, resource.id);
                      props.onOpenChanges?.();
                    }}
                  />
                ))
              ) : props.gitCwd && (show.branch || show.pullRequests || show.git) ? (
                <ThreadDetailsSection
                  headingId="thread-details-version-control-heading"
                  title="Version Control"
                  showHeading={false}
                  separated={density === "full"}
                >
                  <div className="flex flex-col">
                    {show.branch ? (
                      <BranchToolbar layout="panel" panelSection="branch" {...branchToolbarProps} />
                    ) : null}
                    {show.pullRequests ? (
                      <ThreadDetailsThreadPrRows
                        threadRef={activeThreadRef}
                        project={project}
                        composerTarget={props.composerDraftTarget}
                      />
                    ) : null}
                    {show.git && props.gitCwd ? (
                      <GitActionsControl
                        compact={density !== "full"}
                        showActions={visible.gitActions}
                        showChanges={visible.changes}
                        gitCwd={props.gitCwd}
                        workspaceMutationId={props.workspaceMutationId}
                        activeThreadRef={activeThreadRef}
                        {...(props.draftId ? { draftId: props.draftId } : {})}
                        {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
                      />
                    ) : null}
                  </div>
                </ThreadDetailsSection>
              ) : null}

              {!workspace && props.gitCwd && showIssues && issuesPlacement === "inline" ? (
                <BranchIssuesPanel environmentId={props.environmentId} cwd={props.gitCwd} />
              ) : null}

              {density === "full" && !props.draftId && visible.servers ? (
                <ThreadServersPanel environmentId={props.environmentId} threadId={props.threadId} />
              ) : null}

              {density === "full" && !props.draftId && visible.automations ? (
                <ThreadAutomationsPanel
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                />
              ) : null}

              {density === "full" && !props.draftId && (visible.lineage || visible.sideChats) ? (
                <ThreadRelationshipsPanel
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                  showLineage={visible.lineage}
                  showSideChats={visible.sideChats}
                />
              ) : null}

              {thread?.workspaceConfiguration ? (
                <WorkspaceRecoveryControl
                  key={`${props.environmentId}:${props.threadId}:${workspace?.id ?? "preparation"}`}
                  threadRef={activeThreadRef}
                  revisionId={workspace?.id ?? null}
                />
              ) : null}
              {visible.usage ? <ThreadDetailsUsage {...props.usage} /> : null}

              {visible.context && props.usage.contextWindow ? (
                <ThreadDetailsContext usage={props.usage.contextWindow} />
              ) : null}

              {/* Shown only when no section above has content, so an emptied card can be refilled. */}
              <div className="p-2 group-has-[>section>:last-child:not(:empty)]/details-items:hidden">
                <ThreadDetailsControl
                  size="xs"
                  variant="ghost"
                  part="row"
                  panel
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setMenuPosition({ x: rect.left, y: rect.bottom });
                  }}
                >
                  <SlidersHorizontalIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
                  <span className={cn("ml-0.5", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
                    Choose what to show
                  </span>
                </ThreadDetailsControl>
              </div>
            </div>

            <Menu
              open={menuPosition !== null}
              onOpenChange={(open) => !open && setMenuPosition(null)}
            >
              <MenuPopup
                anchor={
                  menuPosition
                    ? {
                        getBoundingClientRect: () =>
                          new DOMRect(menuPosition.x, menuPosition.y, 0, 0),
                      }
                    : undefined
                }
                align="start"
                side="bottom"
              >
                <ThreadDetailsItemsMenuItems />
              </MenuPopup>
            </Menu>
          </>
        );
      }}
    </ThreadDetailsCard>
  );
}

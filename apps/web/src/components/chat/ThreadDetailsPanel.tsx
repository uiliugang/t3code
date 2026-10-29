import { useUiTranslation } from "../../hooks/useUiTranslation";
import { WorkspaceRecoveryControl } from "./WorkspaceRecoveryControl";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { useDiffPanelStore } from "../../diffPanelStore";
import { RepositoryDetails } from "./RepositoryDetails";
import type {
  EditorId,
  EnvironmentId,
  ProjectId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";

import type { DraftId } from "../../composerDraftStore";
import { useT3ProjectFileScripts } from "../../hooks/useT3ProjectFileScripts";
import { type EnvMode, type EnvironmentOption } from "../BranchToolbar.logic";
import { BranchToolbar } from "../BranchToolbar";
import BaseGitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { memo, useState, type ComponentProps } from "react";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { ThreadServersPanel } from "./ThreadServersPanel";

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
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  openInShortcutEnabled: boolean;
  gitCwd: string | null;
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
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  const t = useUiTranslation();
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
    revision: string;
    resourceId: string | null;
  } | null>(null);
  const expandedResourceId =
    expandedRepository?.revision === workspace?.id
      ? expandedRepository?.resourceId
      : primaryResourceId;

  const fileScripts = useT3ProjectFileScripts(
    props.environmentId,
    props.activeProjectScripts ? props.gitCwd : null,
  );
  const activeThreadRef = { environmentId: props.environmentId, threadId: props.threadId };
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
    >
      {(density) => (
        <>
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
              {density === "full" ? (
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

              {props.activeProjectScripts ? (
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
                showOpenInPicker={density !== "essential" && props.showOpenInPicker}
                expanded={expandedResourceId === resource.id}
                onToggle={() =>
                  setExpandedRepository({
                    revision: workspace.id,
                    resourceId: expandedResourceId === resource.id ? null : resource.id,
                  })
                }
                onOpenChanges={() => {
                  useDiffPanelStore.getState().selectRepository(activeThreadRef, resource.id);
                  props.onOpenChanges?.();
                }}
              />
            ))
          ) : props.gitCwd ? (
            <ThreadDetailsSection
              headingId="thread-details-version-control-heading"
              title={props.activeProjectName ?? "Repository"}
              showHeading
              separated={density === "full"}
            >
              <div className="flex flex-col">
                {density !== "essential" && props.showOpenInPicker ? (
                  <OpenInPicker
                    keybindings={props.keybindings}
                    environmentId={props.environmentId}
                    availableEditors={props.availableEditors}
                    openInCwd={props.gitCwd}
                    enableShortcut={props.openInShortcutEnabled}
                    displayMode="panel"
                  />
                ) : null}

                {props.isGitRepo ? (
                  <BranchToolbar layout="panel" panelSection="branch" {...branchToolbarProps} />
                ) : null}
                {props.activeProjectName ? (
                  <GitActionsControl
                    compact={density !== "full"}
                    gitCwd={props.gitCwd}
                    activeThreadRef={activeThreadRef}
                    {...(props.draftId ? { draftId: props.draftId } : {})}
                    {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
                  />
                ) : null}
              </div>
            </ThreadDetailsSection>
          ) : null}

          {thread?.workspaceConfiguration ? (
            <WorkspaceRecoveryControl
              key={workspace?.id ?? "preparation"}
              threadRef={activeThreadRef}
              revisionId={workspace?.id ?? null}
            />
          ) : null}
          {density === "full" && !props.draftId ? (
            <ThreadServersPanel environmentId={props.environmentId} threadId={props.threadId} />
          ) : null}

          {density === "full" && !props.draftId ? (
            <ThreadAutomationsPanel environmentId={props.environmentId} threadId={props.threadId} />
          ) : null}

          {density === "full" && !props.draftId ? (
            <ThreadRelationshipsPanel
              environmentId={props.environmentId}
              threadId={props.threadId}
            />
          ) : null}
        </>
      )}
    </ThreadDetailsCard>
  );
}

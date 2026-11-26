import { isHostPath, workspaceRelativeFilePath } from "@t3tools/shared/path";
import { useProjects, useQuietThreadShell, useServerConfigs } from "../../state/entities";
import { canOpenLinkedIssue } from "@t3tools/client-runtime/issue-links";
import { joinHostPath } from "../files/filePath";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useGT } from "gt-react";
import type {
  EditorId,
  EnvironmentId,
  IssueTrackerKind,
  PreviewAnnotationPayload,
  ProjectId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
  WorkItemId,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { lazy, Suspense } from "react";
import { LinkedThreadPane } from "./LinkedThreadPane";
import SideThreadPane from "./SideThreadPane";
import type { ComposerImageAttachment, DraftId } from "../../composerDraftStore";
import type { ShortcutMatchContext } from "../../keybindings";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { type RightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import {
  PersistentThreadTerminalPanel,
  type PersistentThreadTerminalPanelProps,
} from "../PersistentThreadTerminals";
import { IssueDetailPanel } from "../issue/IssueDetailPanel";
import { pullRequestPanelContext } from "../pullRequest/pullRequestDetail.logic";
import { PullRequestDetailPanel } from "../pullRequest/PullRequestDetailPanel";
import { PullRequestDetailGhost } from "../pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import { ThreadPullRequestsPanel } from "../pullRequest/ThreadPullRequestsPanel";

const ThreadWorkItemsPanel = lazy(() =>
  import("../work-items/WorkItemsPage").then((module) => ({
    default: module.ThreadWorkItemsPanel,
  })),
);
const WorkItemDetailPanel = lazy(() =>
  import("../work-items/WorkItemsPage").then((module) => ({
    default: module.WorkItemDetailPanel,
  })),
);
const RequirementIssueDetailPanel = lazy(() =>
  import("../requirements/IssueDetailPanel").then((module) => ({
    default: module.IssueDetailPanel,
  })),
);

const PreviewPanel = lazy(() =>
  import("../preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const DiffPanel = lazy(() => import("../DiffPanel"));
const DevicePanel = lazy(() =>
  import("../device/DevicePanel").then((module) => ({ default: module.DevicePanel })),
);
const FilePreviewPanel = lazy(() => import("../files/FilePreviewPanel"));

type RightPanelTerminalProps = Omit<
  PersistentThreadTerminalPanelProps,
  "visible" | "threadRef" | "surface"
>;

interface RightPanelPullRequestProps {
  readonly capabilityKnown: boolean;
  readonly supported: boolean;
  readonly projectId: ProjectId | null;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly linkedPullRequest: ThreadLinkedPullRequest | null;
  readonly branchPullRequest: ThreadLinkedPullRequest | null | undefined;
  readonly onBack: (() => void) | undefined;
}

interface RightPanelFileProps {
  readonly projectId?: ProjectId | undefined;
  readonly projectName: string | null;
  readonly workspaceRoot: string | undefined;
  readonly availableEditors: ReadonlyArray<EditorId>;
  readonly pendingSurfaceIds: ReadonlySet<string>;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
}

export function RightPanelSurfaceContent(props: {
  readonly surface: RightPanelSurface | null;
  readonly activeSurfaceId: string | null;
  readonly threadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly configuredPreviewUrls: ReadonlyArray<string>;
  readonly workspaceMutationId: string | null;
  /** What the diff is read under, as the Changes totals are; see `useWorkspaceRevision`. */
  readonly workspaceRevision: string | null;
  readonly getShortcutContext: () => ShortcutMatchContext;
  readonly onSendAnnotation: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
  readonly onCloseSurface: (surface: RightPanelSurface) => void;
  readonly terminal: RightPanelTerminalProps;
  readonly pullRequest: RightPanelPullRequestProps;
  readonly issuesSupported: boolean;
  readonly files: RightPanelFileProps;
  readonly sideChatParentPanel: SideChatParentPanel;
}) {
  const { surface, threadRef, visible, onCloseSurface } = props;
  const workspace = useQuietThreadShell(threadRef)?.workspace;
  const projects = useProjects();
  const configs = useServerConfigs();
  const t = useUiTranslation();
  const gt = useGT();
  if (surface === null) return null;
  switch (surface.kind) {
    case "tasks":
      return (
        <Suspense fallback={null}>
          <ThreadWorkItemsPanel threadRef={threadRef} />
        </Suspense>
      );
    case "preview":
      return (
        <Suspense fallback={null}>
          <PreviewPanel
            mode="embedded"
            threadRef={threadRef}
            tabId={surface.resourceId}
            configuredUrls={props.configuredPreviewUrls}
            visible={visible}
            onSendAnnotation={props.onSendAnnotation}
          />
        </Suspense>
      );
    case "terminal":
      return (
        <PersistentThreadTerminalPanel
          {...props.terminal}
          visible={visible}
          threadRef={threadRef}
          surface={surface}
        />
      );
    case "diff":
      return (
        <Suspense fallback={null}>
          <DiffPanel
            key={scopedThreadKey(threadRef)}
            mode="embedded"
            composerDraftTarget={props.composerDraftTarget}
            workspaceMutationId={props.workspaceRevision}
            visible={visible}
          />
        </Suspense>
      );
    case "pull-request": {
      const pullRequest = props.pullRequest;
      if (!pullRequest.capabilityKnown) return <PullRequestDetailGhost />;
      if (!pullRequest.supported) {
        return (
          <PullRequestsUnavailableState
            title={gt("Pull requests unavailable")}
            error={gt("Update this environment's T3 Code server to browse pull requests.")}
          />
        );
      }
      return (
        <PullRequestDetailPanel
          getShortcutContext={props.getShortcutContext}
          shortcutsEnabled={visible && props.activeSurfaceId === surface.id}
          key={`${scopedThreadKey(threadRef)}:${surface.id}`}
          environmentId={
            (surface.environmentId as EnvironmentId | undefined) ?? props.environmentId
          }
          onSelectPullRequest={(reference) => {
            useRightPanelStore.getState().openPullRequest(threadRef, {
              ...(surface.environmentId === undefined
                ? {}
                : { environmentId: surface.environmentId }),
              projectId: reference.projectId,
              repository: reference.repository,
              number: reference.number,
              ...(reference.host ? { host: reference.host } : {}),
            });
          }}
          threadRef={threadRef}
          reference={{
            projectId: surface.projectId as ProjectId,
            ...(surface.host ? { host: surface.host } : {}),
            repository: surface.repository,
            number: surface.number,
          }}
          initialTab={surface.detailTab ?? "summary"}
          revealUrl={surface.revealUrl}
          onRevealSettled={(revealUrl) => {
            useRightPanelStore.getState().settlePullRequestReveal(threadRef, surface.id, revealUrl);
          }}
          onTabChange={(tab) => {
            useRightPanelStore.getState().setPullRequestDetailTab(threadRef, surface.id, tab);
          }}
          context={pullRequestPanelContext(
            {
              projectId: pullRequest.projectId,
              pullRequests: pullRequest.pullRequests,
              linkedPullRequest: pullRequest.linkedPullRequest,
              branchPullRequest: pullRequest.branchPullRequest,
            },
            surface,
          )}
          composerDraftTarget={props.composerDraftTarget}
          onBack={pullRequest.onBack}
        />
      );
    }
    case "issue": {
      if (!props.pullRequest.capabilityKnown) return <PullRequestDetailGhost />;
      if (!props.issuesSupported) {
        return (
          <PullRequestsUnavailableState
            title={gt("Issues unavailable")}
            error={gt("Update this environment's T3 Code server to browse issues.")}
          />
        );
      }
      const environmentId =
        (surface.environmentId as EnvironmentId | undefined) ?? props.environmentId;
      const tracker = surface.tracker as IssueTrackerKind;
      if (tracker === "github" && surface.url) {
        const capabilities = configs.get(environmentId)?.environment.capabilities;
        if (
          !canOpenLinkedIssue(
            { tracker, url: surface.url, ...(surface.host ? { host: surface.host } : {}) },
            capabilities,
          )
        ) {
          const external = /^https?:\/\//i.test(surface.url) && URL.canParse(surface.url);
          return (
            <PullRequestsUnavailableState
              title={gt("Issues unavailable")}
              error={gt("Update this environment's T3 Code server to browse issues.")}
              {...(external
                ? { host: { url: surface.url, openLabel: gt("Open in browser") } }
                : {})}
            />
          );
        }
      }
      return (
        <IssueDetailPanel
          key={`${environmentId}:${surface.id}`}
          environmentId={environmentId}
          reference={{
            projectId: surface.projectId as ProjectId,
            tracker,
            ...(surface.host ? { host: surface.host } : {}),
            scope: surface.scope,
            key: surface.key,
            ...(surface.url ? { url: surface.url } : {}),
          }}
          threadRef={threadRef}
          onSelectPullRequest={(reference) => {
            useRightPanelStore.getState().openPullRequest(threadRef, {
              ...(surface.environmentId === undefined
                ? {}
                : { environmentId: surface.environmentId }),
              projectId: reference.projectId,
              repository: reference.repository,
              number: reference.number,
              ...(reference.host ? { host: reference.host } : {}),
            });
          }}
          onSelectIssue={({ host, ...reference }) => {
            useRightPanelStore.getState().openIssue(threadRef, {
              ...(surface.environmentId === undefined
                ? {}
                : { environmentId: surface.environmentId }),
              ...reference,
              ...(host ? { host } : {}),
            });
          }}
        />
      );
    }
    case "pull-requests":
      return <ThreadPullRequestsPanel threadRef={threadRef} />;
    case "work-item": {
      const targetEnvironmentId =
        (surface.environmentId as EnvironmentId | undefined) ?? props.environmentId;
      return (
        <Suspense fallback={null}>
          <WorkItemDetailPanel
            key={surface.id}
            embedded
            panelRef={threadRef}
            environmentId={targetEnvironmentId}
            id={surface.workItemId as WorkItemId}
          />
        </Suspense>
      );
    }
    case "requirement-issue": {
      const targetEnvironmentId =
        (surface.environmentId as EnvironmentId | undefined) ?? props.environmentId;
      const project = projects.find(
        (entry) => entry.environmentId === targetEnvironmentId && entry.id === surface.projectId,
      );
      return (
        <Suspense fallback={null}>
          <RequirementIssueDetailPanel
            key={surface.id}
            embedded
            panelRef={threadRef}
            environmentId={targetEnvironmentId}
            target={{
              projectId: surface.projectId as ProjectId,
              provider: surface.provider,
              ...(surface.host ? { host: surface.host } : {}),
              ...(surface.scope ? { scope: surface.scope } : {}),
              ...(surface.url ? { url: surface.url } : {}),
            }}
            id={surface.issueId}
            cwd={project?.workspaceRoot ?? ""}
            projectTitle={project?.title ?? surface.projectId}
          />
        </Suspense>
      );
    }
    case "thread":
      // Not lazy: revealing a suspended tiptap editor tears down its view and crashes the composer.
      return (
        <SideThreadPane
          key={surface.id}
          parentRef={threadRef}
          surface={surface}
          parentPanel={props.sideChatParentPanel}
          onClose={() => onCloseSurface(surface)}
        />
      );
    case "linked-thread":
      return (
        <LinkedThreadPane
          key={surface.id}
          panelRef={threadRef}
          surface={surface}
          visible={visible && props.activeSurfaceId === surface.id}
        />
      );
    case "device":
      return (
        <Suspense fallback={null}>
          <DevicePanel
            mode="embedded"
            threadRef={threadRef}
            key={surface.id}
            surface={surface}
            visible={visible}
            onDismissSetup={() => {
              props.onCloseSurface(surface);
              useRightPanelStore.getState().show(threadRef);
            }}
          />
        </Suspense>
      );
    case "files":
    case "file": {
      const files = props.files;
      const attachment = surface.kind === "file" ? surface.attachment : undefined;
      const requestedPath = surface.kind === "file" ? surface.relativePath : null;
      const repository =
        workspace?.resources.find(
          (resource) =>
            requestedPath !== null &&
            workspaceRelativeFilePath(requestedPath, resource.checkoutRoot) !== null,
        ) ??
        workspace?.resources.find(
          (resource) =>
            resource.id ===
            workspace.bindings.find((binding) => binding.rootId === workspace.primaryRootId)
              ?.resourceId,
        );
      const cwd = repository?.checkoutRoot ?? files.workspaceRoot;
      const relative =
        repository && requestedPath
          ? workspaceRelativeFilePath(requestedPath, repository.checkoutRoot)
          : requestedPath;
      const relativePath = relative === "." ? null : (relative ?? requestedPath);
      const openPath = (filePath: string) =>
        files.onOpenFile(
          repository && !isHostPath(filePath)
            ? joinHostPath(repository.checkoutRoot, filePath)
            : filePath,
        );
      if (!attachment && (files.projectName === null || !files.workspaceRoot)) return null;
      return (
        <Suspense fallback={null}>
          <div className="flex h-full min-h-0 flex-col">
            {!attachment && workspace && workspace.resources.length > 1 ? (
              <div className="border-b border-border px-3 py-2">
                <select
                  aria-label={t("Repository")}
                  className="w-full bg-transparent p-0.5 text-sm"
                  value={repository?.id}
                  onChange={(event) => {
                    const selected = workspace.resources.find(
                      (resource) => resource.id === event.target.value,
                    );
                    if (selected) files.onOpenFile(selected.checkoutRoot);
                  }}
                >
                  {workspace.resources.map((resource) => (
                    <option key={resource.id} value={resource.id}>
                      {workspace.bindings
                        .filter((binding) => binding.resourceId === resource.id)
                        .map((binding) => binding.alias)
                        .join(" / ")}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col">
              <FilePreviewPanel
                key={`${props.environmentId}:${attachment ? `attachment:${attachment.id}` : cwd}`}
                environmentId={props.environmentId}
                cwd={cwd ?? ""}
                projectName={files.projectName ?? ""}
                threadRef={threadRef}
                composerDraftTarget={props.composerDraftTarget}
                keybindings={props.keybindings}
                availableEditors={files.availableEditors}
                openInShortcutEnabled={visible}
                relativePath={relativePath}
                {...(attachment ? { attachment } : {})}
                revealLine={surface.kind === "file" ? (surface.revealLine ?? null) : null}
                revealRequestId={surface.kind === "file" ? surface.revealRequestId : 0}
                onOpenFile={openPath}
                onNavigateFolder={(relativePath, folderTrail, keepSource) =>
                  useRightPanelStore
                    .getState()
                    .navigateFolder(
                      threadRef,
                      surface.id,
                      repository && !isHostPath(relativePath)
                        ? joinHostPath(repository.checkoutRoot, relativePath)
                        : relativePath,
                      folderTrail,
                      keepSource,
                    )
                }
                folderTrail={surface.folderTrail}
                onPendingChange={(filePath, pending) =>
                  files.onPendingChange(
                    repository && !isHostPath(filePath)
                      ? joinHostPath(repository.checkoutRoot, filePath)
                      : filePath,
                    pending,
                  )
                }
                selectedFilePending={
                  surface.kind === "file" && files.pendingSurfaceIds.has(surface.id)
                }
                workspaceMutationId={props.workspaceMutationId}
              />
            </div>
          </div>
        </Suspense>
      );
    }
  }
}

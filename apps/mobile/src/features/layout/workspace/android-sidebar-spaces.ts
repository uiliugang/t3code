import {
  resolveSidebarSpaceScope,
  sidebarSpaceProjectKey,
  type SidebarSpace,
} from "@t3tools/client-runtime/sidebar-spaces";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { workspaceRoutesOf } from "../workspace-overlay-routes";

export interface AndroidSidebarSpace extends SidebarSpace {
  readonly lastThread?: ScopedThreadRef;
}

export interface AndroidSidebarSpaces {
  readonly selectedId: string | null;
  readonly spaces: readonly AndroidSidebarSpace[];
}

export const EMPTY_ANDROID_SIDEBAR_SPACES: AndroidSidebarSpaces = { selectedId: null, spaces: [] };

export function activeAndroidSidebarSpace(preferences: AndroidSidebarSpaces) {
  return preferences.spaces.find((space) => space.id === preferences.selectedId) ?? null;
}

export function availableAndroidSidebarProjects(
  projects: readonly EnvironmentProject[],
  allowedEnvironmentIds: ReadonlySet<EnvironmentId>,
) {
  return projects.filter(
    (project) =>
      project.archivedAt == null &&
      !project.isScratch &&
      allowedEnvironmentIds.has(project.environmentId),
  );
}

export function androidSidebarSpaceScope(
  space: AndroidSidebarSpace | null,
  available: readonly EnvironmentProject[],
) {
  return resolveSidebarSpaceScope(
    space,
    available.map((project) => ({ environmentId: project.environmentId, projectId: project.id })),
  );
}

export function androidSidebarSpaceDraftTargets(
  space: AndroidSidebarSpace,
  available: readonly EnvironmentProject[],
  canOperate: (environmentId: EnvironmentId) => boolean,
) {
  const keys = new Set(space.projectRefs.map(sidebarSpaceProjectKey));
  return available.filter(
    (project) =>
      canOperate(project.environmentId) &&
      keys.has(
        sidebarSpaceProjectKey({ environmentId: project.environmentId, projectId: project.id }),
      ),
  );
}

export function androidSidebarSpaceAnchor(
  space: AndroidSidebarSpace,
  available: readonly EnvironmentProject[],
  findThread: (
    ref: ScopedThreadRef,
  ) =>
    | { readonly projectId: string; readonly archivedAt: unknown; readonly deletedAt?: unknown }
    | undefined,
): ScopedThreadRef | null {
  const ref = space.lastThread;
  if (!ref) return null;
  const thread = findThread(ref);
  if (!thread || thread.archivedAt !== null || thread.deletedAt != null) return null;
  const scope = androidSidebarSpaceScope(space, available);
  return scope.kind === "space" &&
    scope.projectRefs.some(
      (project) =>
        project.environmentId === ref.environmentId && project.projectId === thread.projectId,
    )
    ? ref
    : null;
}

export function visibleAndroidWorkspaceThread(state: {
  readonly index: number;
  readonly routes: ReadonlyArray<{ readonly name: string; readonly params?: object }>;
}): ScopedThreadRef | null {
  const route = workspaceRoutesOf(state.routes.slice(0, state.index + 1)).workspace.at(-1);
  const params = route?.name === "Thread" ? route.params : undefined;
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

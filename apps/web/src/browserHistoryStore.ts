import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  INCOGNITO_BROWSER_PROFILE_ID,
  type PreviewSessionSnapshot,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";

import {
  previewStateAtom,
  previewThreadRefsAtom,
  readThreadPreviewState,
  type ThreadPreviewState,
} from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  readProject,
  readProjects,
  readThreadShell,
  useProjects,
  useQuietThreadShell,
} from "~/state/entities";
import { readPrimaryEnvironmentId, usePrimaryEnvironmentId } from "~/state/environments";
import { readPreparedConnection } from "~/state/session";

import { useComposerDraftStore } from "./composerDraftStore";
import {
  ensureClientSettingsHydrated,
  getClientSettings,
  isClientSettingsHydrated,
  useClientSettings,
} from "./hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { buildPhysicalToLogicalProjectKeyMap } from "./sidebarProjectGrouping";
import type { Project } from "./types";

import {
  createBrowserHistoryStore,
  normalizeHistoryUrl,
  titleLookupKey,
  type BrowserHistoryEntry,
} from "./browserHistoryPersistence";

export {
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  BROWSER_HISTORY_MAX_PROJECTS,
  isValidHistoryTimestamp,
  mergeBrowserHistoryState,
  migratePersistedBrowserHistoryState,
  normalizeHistoryUrl,
  upsertHistoryEntry,
  type BrowserHistoryEntry,
} from "./browserHistoryPersistence";

export const useBrowserHistoryStore = createBrowserHistoryStore((ref, urls) => {
  recordPreviewTitles(ref, readThreadPreviewState(ref), { urls });
});

const PENDING_MAX_PER_THREAD = 10;
const PENDING_MAX_THREADS = 20;

function addPendingByThread<T>(
  pendingByThreadKey: Record<string, T[]>,
  threadKey: string,
  item: T,
): Record<string, T[]> {
  const existing = pendingByThreadKey[threadKey] ?? [];
  const next = { ...pendingByThreadKey };
  next[threadKey] = [...existing, item].slice(-PENDING_MAX_PER_THREAD);
  const keys = Object.keys(next);
  if (keys.length > PENDING_MAX_THREADS) {
    const oldestKey = keys[0];
    if (oldestKey !== undefined && oldestKey !== threadKey) delete next[oldestKey];
  }
  return next;
}

/**
 * History follows the sidebar's project rows, so a duplicate row shares the
 * history of the group it is listed under rather than keying by its own path.
 */
function deriveHistoryProjectKey(
  project: Project,
  projects: ReadonlyArray<Project>,
  settings: ProjectGroupingSettings,
  primaryEnvironmentId: EnvironmentId | null,
): string {
  return (
    buildPhysicalToLogicalProjectKeyMap({ projects, settings, primaryEnvironmentId }).get(
      derivePhysicalProjectKey(project),
    ) ?? deriveLogicalProjectKeyFromSettings(project, settings)
  );
}

/** Server threads name their project in the shell; drafts in the composer draft store. */
function readThreadProjectRef(ref: ScopedThreadRef): ScopedProjectRef | null {
  const projectId = readThreadShell(ref)?.projectId;
  if (projectId) return scopeProjectRef(ref.environmentId, projectId);
  const draft = useComposerDraftStore.getState().getDraftSessionByRef(ref);
  return draft ? scopeProjectRef(draft.environmentId, draft.projectId) : null;
}

/**
 * Registers the thread under its current project so queued visits and titles
 * land. Until the project loads, or client settings hydrate (the grouping is
 * unknown before then), the last registration stands and writes stay queued.
 */
function resolveThreadProjectKey(ref: ScopedThreadRef): string | undefined {
  const state = useBrowserHistoryStore.getState();
  const registered = state.projectKeyByThreadKey[scopedThreadKey(ref)];
  if (!isClientSettingsHydrated()) {
    void ensureClientSettingsHydrated().then(
      () => resolveThreadProjectKey(ref),
      () => undefined,
    );
    return registered;
  }
  const projectRef = readThreadProjectRef(ref);
  const project = projectRef ? readProject(projectRef) : null;
  if (!project) return registered;
  const projectKey = deriveHistoryProjectKey(
    project,
    readProjects(),
    selectProjectGroupingSettings(getClientSettings()),
    readPrimaryEnvironmentId(),
  );
  state.registerThreadProject(ref, projectKey);
  return projectKey;
}

export function recordVisitForThread(ref: ScopedThreadRef, url: string, at?: number): void {
  const threadKey = scopedThreadKey(ref);
  const projectKey = resolveThreadProjectKey(ref);
  const state = useBrowserHistoryStore.getState();
  const visitAt = at ?? Date.now();
  const connection = readPreparedConnection(ref.environmentId);
  const environmentHostname = connection ? new URL(connection.httpBaseUrl).hostname : null;
  if (!projectKey) {
    useBrowserHistoryStore.setState({
      pendingVisitsByThreadKey: addPendingByThread(state.pendingVisitsByThreadKey, threadKey, {
        url,
        at: visitAt,
        environmentHostname,
      }),
    });
    return;
  }
  state.recordVisit(projectKey, url, visitAt, { environmentHostname });
  // A page can settle before the address bar records its visit.
  recordPreviewTitles(ref, readThreadPreviewState(ref), { urls: [url] });
}

/**
 * History is shared across a project's threads and settled sessions are retained,
 * so replaying an old settle would clobber another thread's newer title. Visits
 * only fill untitled entries; settles apply only pages that loaded or retitled.
 */
function recordPreviewTitles(
  ref: ScopedThreadRef,
  preview: ThreadPreviewState,
  only:
    | { readonly urls: ReadonlyArray<string> }
    | { readonly changedSince: ThreadPreviewState["sessions"] },
): void {
  const state = useBrowserHistoryStore.getState();
  const projectKey = state.projectKeyByThreadKey[scopedThreadKey(ref)];
  if (!projectKey) return;
  const connection = readPreparedConnection(ref.environmentId);
  const environmentHostname = connection ? new URL(connection.httpBaseUrl).hostname : null;
  const titleKey = (url: string) => {
    const normalized = normalizeHistoryUrl(url);
    return normalized ? titleLookupKey(normalized, environmentHostname) : null;
  };
  const visitKeys = "urls" in only ? new Set(only.urls.map(titleKey)) : null;
  // Resizes and list reconciles replace a session without loading a new page.
  const settledAgain = (session: PreviewSessionSnapshot, previous?: PreviewSessionSnapshot) =>
    previous?.navStatus._tag === "Success" &&
    session.navStatus._tag === "Success" &&
    previous.navStatus.url === session.navStatus.url &&
    previous.navStatus.title === session.navStatus.title;
  const include = (session: PreviewSessionSnapshot, url: string) =>
    "changedSince" in only
      ? !settledAgain(session, only.changedSince[session.tabId])
      : (visitKeys?.has(titleKey(url)) ?? false);
  // A fill uses the newest eligible title first because it only sets an untitled entry.
  const sessions = Object.values(preview.sessions).toSorted((a, b) =>
    "urls" in only
      ? b.updatedAt.localeCompare(a.updatedAt)
      : a.updatedAt.localeCompare(b.updatedAt),
  );
  for (const session of sessions) {
    const status = session.navStatus;
    if (session.profileId === INCOGNITO_BROWSER_PROFILE_ID) continue;
    if (status._tag !== "Success" || !status.title || !include(session, status.url)) continue;
    state.setTitleForUrl(projectKey, status.url, status.title, {
      environmentHostname,
      onlyIfUntitled: "urls" in only,
    });
  }
}

/** Records settled page titles for every thread with previews, for the life of the page. */
export function startPreviewTitleRecording(): () => void {
  const followed = new Map<string, () => void>();
  const followNewThreads = (refs: ReadonlyMap<string, ScopedThreadRef>) => {
    for (const [threadKey, threadRef] of refs) {
      if (followed.has(threadKey)) continue;
      const atom = previewStateAtom(threadKey);
      let previousSessions = appAtomRegistry.get(atom).sessions;
      followed.set(
        threadKey,
        appAtomRegistry.subscribe(atom, (next) => {
          if (next.sessions === previousSessions) return;
          const changedSince = previousSessions;
          previousSessions = next.sessions;
          recordPreviewTitles(threadRef, next, { changedSince });
        }),
      );
    }
  };
  const stopIndex = appAtomRegistry.subscribe(previewThreadRefsAtom, followNewThreads, {
    immediate: true,
  });
  return () => {
    stopIndex();
    for (const stop of followed.values()) stop();
  };
}

export function removeUrlForThread(ref: ScopedThreadRef, url: string): void {
  const projectKey = resolveThreadProjectKey(ref);
  if (!projectKey) return;
  useBrowserHistoryStore.getState().removeUrl(projectKey, url);
}

const EMPTY_HISTORY: ReadonlyArray<BrowserHistoryEntry> = [];

function useThreadHistoryProjectKey(ref: ScopedThreadRef): string | null {
  const threadKey = scopedThreadKey(ref);
  const shellProjectId = useQuietThreadShell(ref)?.projectId ?? null;
  const draftProjectKey = useComposerDraftStore((state) => {
    const draft = state.getDraftSessionByRef(ref);
    return draft ? scopedProjectKey(scopeProjectRef(draft.environmentId, draft.projectId)) : null;
  });
  const projectKey = shellProjectId
    ? scopedProjectKey(scopeProjectRef(ref.environmentId, shellProjectId))
    : draftProjectKey;
  const projects = useProjects();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const registered = useBrowserHistoryStore(
    (state) => state.projectKeyByThreadKey[threadKey] ?? null,
  );
  const project = projects.find(
    (candidate) =>
      scopedProjectKey(scopeProjectRef(candidate.environmentId, candidate.id)) === projectKey,
  );
  return project
    ? deriveHistoryProjectKey(project, projects, settings, primaryEnvironmentId)
    : registered;
}

export function useThreadRecentHistory(
  ref: ScopedThreadRef,
  limit: number,
): ReadonlyArray<BrowserHistoryEntry> {
  const projectKey = useThreadHistoryProjectKey(ref);
  return useBrowserHistoryStore(
    useShallow((state) => {
      const entries = projectKey ? state.byProjectKey[projectKey] : undefined;
      return entries && entries.length > 0 ? entries.slice(0, limit) : EMPTY_HISTORY;
    }),
  );
}

export function resetBrowserHistoryForTests(): void {
  useBrowserHistoryStore.setState({
    byProjectKey: {},
    projectKeyByThreadKey: {},
    pendingVisitsByThreadKey: {},
  });
}

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { isLocalLoopbackHost, normalizeHostname } from "@t3tools/shared/hostClassification";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { create } from "zustand";

export type BrowserHistoryEntry = { url: string; lastVisitedAt: number; title?: string };

export const BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT = 50;
export const BROWSER_HISTORY_MAX_PROJECTS = 20;
const BROWSER_HISTORY_MAX_URL_LENGTH = 2048;
const BROWSER_HISTORY_MAX_TITLE_LENGTH = 512;
const MAX_VALID_DATE_MS = 8_640_000_000_000_000;

export function isValidHistoryTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_VALID_DATE_MS
  );
}

export function normalizeHistoryUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(normalizePreviewUrl(raw));
  } catch {
    return null;
  }
  parsed.username = parsed.password = "";
  return parsed.href.length > BROWSER_HISTORY_MAX_URL_LENGTH ? null : parsed.href;
}

export function titleLookupKey(normalized: string, environmentHostname?: string | null): string {
  const parsed = new URL(visitLookupKey(normalized, environmentHostname));
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/"))
    parsed.pathname = parsed.pathname.slice(0, -1);
  return parsed.href;
}

function visitLookupKey(normalized: string, environmentHostname?: string | null): string {
  const parsed = new URL(normalized);
  const host = normalizeHostname(parsed.hostname);
  const environmentHost = environmentHostname && normalizeHostname(environmentHostname);
  if (isLocalLoopbackHost(host) || host === "0.0.0.0" || host === environmentHost)
    parsed.hostname = "local";
  return parsed.href;
}

function isStableLocalUrl(normalized: string): boolean {
  const host = normalizeHostname(new URL(normalized).hostname);
  return isLocalLoopbackHost(host) || host === "0.0.0.0";
}

export function upsertHistoryEntry(
  entries: ReadonlyArray<BrowserHistoryEntry>,
  url: string,
  at: number,
  options?: { insertOrdered?: boolean; environmentHostname?: string | null },
): BrowserHistoryEntry[] {
  const key = visitLookupKey(url, options?.environmentHostname);
  const existing = entries.find(
    (candidate) => visitLookupKey(candidate.url, options?.environmentHostname) === key,
  );
  const rest = entries.filter(
    (candidate) => visitLookupKey(candidate.url, options?.environmentHostname) !== key,
  );
  const visitedAt =
    options?.insertOrdered && existing && existing.lastVisitedAt > at ? existing.lastVisitedAt : at;
  const storedUrl =
    existing && (isStableLocalUrl(existing.url) || !isStableLocalUrl(url)) ? existing.url : url;
  const entry: BrowserHistoryEntry = existing
    ? { ...existing, url: storedUrl, lastVisitedAt: visitedAt }
    : { url, lastVisitedAt: visitedAt };
  if (!options?.insertOrdered)
    return [entry, ...rest].slice(0, BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT);
  const index = rest.findIndex((candidate) => candidate.lastVisitedAt < entry.lastVisitedAt);
  const next = index === -1 ? [...rest, entry] : rest.toSpliced(index, 0, entry);
  return next.slice(0, BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT);
}

function evictExcessProjects(
  byProjectKey: Record<string, BrowserHistoryEntry[]>,
): Record<string, BrowserHistoryEntry[]> {
  const keys = Object.keys(byProjectKey);
  if (keys.length <= BROWSER_HISTORY_MAX_PROJECTS) return byProjectKey;
  const kept = keys
    .toSorted(
      (a, b) =>
        (byProjectKey[b]?.[0]?.lastVisitedAt ?? 0) - (byProjectKey[a]?.[0]?.lastVisitedAt ?? 0),
    )
    .slice(0, BROWSER_HISTORY_MAX_PROJECTS);
  return Object.fromEntries(kept.map((key) => [key, byProjectKey[key] ?? []]));
}

export function migratePersistedBrowserHistoryState(persistedState: unknown): {
  byProjectKey: Record<string, BrowserHistoryEntry[]>;
} {
  if (!persistedState || typeof persistedState !== "object") return { byProjectKey: {} };
  const raw = (persistedState as { byProjectKey?: unknown }).byProjectKey;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { byProjectKey: {} };
  const byProjectKey: Record<string, BrowserHistoryEntry[]> = {};
  for (const [projectKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const seenUrls = new Set<string>();
    const entries = value
      .flatMap<BrowserHistoryEntry>((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const { url, lastVisitedAt, title } = candidate as Record<string, unknown>;
        if (typeof url !== "string") return [];
        const normalizedUrl = normalizeHistoryUrl(url);
        if (!normalizedUrl) return [];
        if (!isValidHistoryTimestamp(lastVisitedAt)) return [];
        return [
          {
            url: normalizedUrl,
            lastVisitedAt,
            ...(typeof title === "string" && title.length > 0
              ? { title: title.slice(0, BROWSER_HISTORY_MAX_TITLE_LENGTH) }
              : {}),
          },
        ];
      })
      .toSorted((a, b) => b.lastVisitedAt - a.lastVisitedAt)
      .filter((entry) => {
        const key = visitLookupKey(entry.url);
        if (seenUrls.has(key)) return false;
        seenUrls.add(key);
        return true;
      })
      .slice(0, BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT);
    if (entries.length > 0) byProjectKey[projectKey] = entries;
  }
  return { byProjectKey: evictExcessProjects(byProjectKey) };
}

const BROWSER_HISTORY_STORAGE_KEY = "t3code:browser-history:v1";

const MAX_PERSISTED_THREAD_MAPPINGS = 100;
type PendingVisit = { url: string; at: number; environmentHostname: string | null };

interface BrowserHistoryStoreState {
  byProjectKey: Record<string, BrowserHistoryEntry[]>;
  projectKeyByThreadKey: Record<string, string>;
  pendingVisitsByThreadKey: Record<string, PendingVisit[]>;
  recordVisit: (
    projectKey: string,
    url: string,
    at: number,
    options?: { insertOrdered?: boolean; environmentHostname?: string | null },
  ) => void;
  setTitleForUrl: (
    projectKey: string,
    url: string,
    title: string,
    options?: { environmentHostname?: string | null; onlyIfUntitled?: boolean },
  ) => void;
  removeUrl: (projectKey: string, url: string) => void;
  registerThreadProject: (ref: ScopedThreadRef, projectKey: string) => void;
}

type PersistedBrowserHistory = Pick<
  BrowserHistoryStoreState,
  "byProjectKey" | "projectKeyByThreadKey"
>;

type UpdateHistory = (state: PersistedBrowserHistory) => PersistedBrowserHistory;

function boundThreadMappings(
  previous: PersistedBrowserHistory,
  next: PersistedBrowserHistory,
): PersistedBrowserHistory {
  return {
    ...next,
    projectKeyByThreadKey: Object.fromEntries(
      Object.entries(next.projectKeyByThreadKey)
        // Keep new registrations for empty projects, but drop projects that lost their history.
        .filter(
          ([, projectKey]) =>
            !Object.hasOwn(previous.byProjectKey, projectKey) ||
            Object.hasOwn(next.byProjectKey, projectKey),
        )
        .slice(-MAX_PERSISTED_THREAD_MAPPINGS),
    ),
  };
}

const HISTORY_OBJECT_STORE = "history";
const EMPTY_PERSISTED_HISTORY: PersistedBrowserHistory = {
  byProjectKey: {},
  projectKeyByThreadKey: {},
};
let historyDatabase: Promise<IDBDatabase> | undefined;
let historyChannel: BroadcastChannel | undefined;

function readLegacyHistory<Missing = PersistedBrowserHistory>(
  missing: Missing = EMPTY_PERSISTED_HISTORY as Missing,
): PersistedBrowserHistory | Missing {
  try {
    const value = window.localStorage.getItem(BROWSER_HISTORY_STORAGE_KEY);
    if (value === null) return missing;
    const parsed: { state?: unknown } | null = JSON.parse(value);
    return {
      ...migratePersistedBrowserHistoryState(parsed?.state),
      projectKeyByThreadKey: migratePersistedThreadProjectKeys(parsed?.state),
    };
  } catch {
    return EMPTY_PERSISTED_HISTORY;
  }
}

function retireLegacyHistory(): void {
  try {
    window.localStorage.removeItem(BROWSER_HISTORY_STORAGE_KEY);
  } catch {
    // The browser can deny access to localStorage independently of IndexedDB.
  }
}

// localStorage can gain visits after migration: from the fallback below, or a tab on an older build.
function mergeLegacyHistory(
  saved: PersistedBrowserHistory,
  legacy: PersistedBrowserHistory,
): PersistedBrowserHistory {
  const byProjectKey = { ...saved.byProjectKey };
  for (const [projectKey, entries] of Object.entries(legacy.byProjectKey))
    byProjectKey[projectKey] = [...(byProjectKey[projectKey] ?? []), ...entries];
  return {
    ...migratePersistedBrowserHistoryState({ byProjectKey }),
    projectKeyByThreadKey: { ...legacy.projectKeyByThreadKey, ...saved.projectKeyByThreadKey },
  };
}

// Without IndexedDB, merge into the freshest localStorage snapshot so a reload keeps new visits.
function transactLegacyHistory(update: UpdateHistory, current: PersistedBrowserHistory) {
  const previous = readLegacyHistory(current);
  const next = update(previous);
  if (next === previous) return previous;
  const history = boundThreadMappings(previous, next);
  try {
    window.localStorage.setItem(
      BROWSER_HISTORY_STORAGE_KEY,
      JSON.stringify({ state: history, version: 1 }),
    );
  } catch {
    // History stays in memory when the browser denies both storage APIs.
  }
  return history;
}

function invalidateHistoryDatabase(opening: Promise<IDBDatabase>): void {
  if (historyDatabase === opening) historyDatabase = undefined;
}

function openHistoryDatabase() {
  if (historyDatabase) return historyDatabase;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(BROWSER_HISTORY_STORAGE_KEY, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(HISTORY_OBJECT_STORE);
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => invalidateHistoryDatabase(opening);
      db.onversionchange = () => {
        invalidateHistoryDatabase(opening);
        db.close();
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
  historyDatabase = opening;
  void opening.catch(() => invalidateHistoryDatabase(opening));
  return opening;
}

async function transactIndexedHistory(update?: UpdateHistory, retry = true) {
  const opening = openHistoryDatabase();
  const db = await opening;
  let transaction: IDBTransaction;
  try {
    transaction = db.transaction(HISTORY_OBJECT_STORE, update ? "readwrite" : "readonly");
  } catch (error) {
    if (error instanceof DOMException && error.name === "InvalidStateError") {
      invalidateHistoryDatabase(opening);
      if (retry) return transactIndexedHistory(update, false);
    }
    throw error;
  }

  return new Promise<{ history: PersistedBrowserHistory; changed: boolean }>((resolve, reject) => {
    const store = transaction.objectStore(HISTORY_OBJECT_STORE);
    const request = store.get(BROWSER_HISTORY_STORAGE_KEY);
    let history: PersistedBrowserHistory;
    let changed = false;
    request.onsuccess = () => {
      const saved = request.result as PersistedBrowserHistory | undefined;
      const legacy = update ? readLegacyHistory(null) : null;
      const previous =
        saved && legacy
          ? mergeLegacyHistory(saved, legacy)
          : (saved ?? legacy ?? EMPTY_PERSISTED_HISTORY);
      const next = update?.(previous) ?? previous;
      history = next === previous ? previous : boundThreadMappings(previous, next);
      changed = history !== saved;
      if (update && changed) store.put(history, BROWSER_HISTORY_STORAGE_KEY);
    };
    transaction.oncomplete = () => {
      // Keep the migration source until the IndexedDB snapshot has committed.
      if (update) retireLegacyHistory();
      resolve({ history, changed });
    };
    transaction.onabort = () => reject(transaction.error);
  });
}

export function createBrowserHistoryStore(
  onVisitsDrained?: (ref: ScopedThreadRef, urls: ReadonlyArray<string>) => void,
) {
  const useBrowserHistoryStore = create<BrowserHistoryStoreState>()((set, get) => {
    const publish = ({ byProjectKey }: PersistedBrowserHistory) => {
      if (byProjectKey !== get().byProjectKey) set({ byProjectKey });
    };
    const updateHistory = (update: UpdateHistory) => {
      if (typeof window === "undefined") {
        publish(update(get()));
        return;
      }
      void transactIndexedHistory(update).then(
        ({ history, changed }) => {
          publish(history);
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel is scoped to the origin
          if (changed) historyChannel?.postMessage(null);
        },
        () => {
          const { byProjectKey, projectKeyByThreadKey } = get();
          publish(transactLegacyHistory(update, { byProjectKey, projectKeyByThreadKey }));
        },
      );
    };

    return mergeBrowserHistoryState(undefined, {
      byProjectKey: {},
      projectKeyByThreadKey: {},
      pendingVisitsByThreadKey: {},
      recordVisit: (projectKey, url, at, options) => {
        const normalized = normalizeHistoryUrl(url);
        if (!normalized) return;
        updateHistory((state) => {
          const entries = state.byProjectKey[projectKey] ?? [];
          return {
            ...state,
            byProjectKey: evictExcessProjects({
              ...state.byProjectKey,
              [projectKey]: upsertHistoryEntry(entries, normalized, at, {
                ...options,
                insertOrdered: options?.insertOrdered || (entries[0]?.lastVisitedAt ?? at) > at,
              }),
            }),
          };
        });
      },
      setTitleForUrl: (projectKey, url, title, options) => {
        const normalized = normalizeHistoryUrl(url);
        const trimmed = title.trim().slice(0, BROWSER_HISTORY_MAX_TITLE_LENGTH);
        if (!normalized || trimmed.length === 0) return;
        const key = titleLookupKey(normalized, options?.environmentHostname);
        updateHistory((state) => {
          const entries = state.byProjectKey[projectKey];
          const index =
            entries?.findIndex(
              (candidate) => titleLookupKey(candidate.url, options?.environmentHostname) === key,
            ) ?? -1;
          const entry = entries?.[index];
          if (
            !entries ||
            !entry ||
            entry.title === trimmed ||
            (entry.title && options?.onlyIfUntitled)
          )
            return state;
          return {
            ...state,
            byProjectKey: {
              ...state.byProjectKey,
              [projectKey]: entries.with(index, { ...entry, title: trimmed }),
            },
          };
        });
      },
      removeUrl: (projectKey, url) => {
        const normalized = normalizeHistoryUrl(url);
        if (!normalized) return;
        updateHistory((state) => {
          const entries = state.byProjectKey[projectKey];
          if (!entries) return state;
          const next = entries.filter((candidate) => candidate.url !== normalized);
          if (next.length === entries.length) return state;
          const byProjectKey = { ...state.byProjectKey };
          if (next.length === 0) delete byProjectKey[projectKey];
          else byProjectKey[projectKey] = next;
          return { ...state, byProjectKey };
        });
      },
      registerThreadProject: (ref, projectKey) => {
        const threadKey = scopedThreadKey(ref);
        const state = get();
        const pendingVisits = state.pendingVisitsByThreadKey[threadKey];
        if (state.projectKeyByThreadKey[threadKey] === projectKey && !pendingVisits) return;
        const nextPendingVisits = { ...state.pendingVisitsByThreadKey };
        delete nextPendingVisits[threadKey];
        const recordMapping = (mappings: BrowserHistoryStoreState["projectKeyByThreadKey"]) => {
          const { [threadKey]: _previous, ...otherProjects } = mappings;
          return migratePersistedThreadProjectKeys({
            projectKeyByThreadKey: { ...otherProjects, [threadKey]: projectKey },
          });
        };
        set({
          projectKeyByThreadKey: recordMapping(state.projectKeyByThreadKey),
          pendingVisitsByThreadKey: nextPendingVisits,
        });
        updateHistory((shared) =>
          shared.projectKeyByThreadKey[threadKey] === projectKey
            ? shared
            : { ...shared, projectKeyByThreadKey: recordMapping(shared.projectKeyByThreadKey) },
        );
        for (const visit of pendingVisits ?? [])
          get().recordVisit(projectKey, visit.url, visit.at, {
            insertOrdered: true,
            environmentHostname: visit.environmentHostname,
          });
        if (pendingVisits)
          onVisitsDrained?.(
            ref,
            pendingVisits.map((visit) => visit.url),
          );
      },
    });
  });

  if (typeof window !== "undefined") {
    try {
      historyChannel = new BroadcastChannel(BROWSER_HISTORY_STORAGE_KEY);
    } catch {
      // History still persists when the browser cannot send change notifications.
    }
    if (historyChannel) {
      historyChannel.onmessage = () => {
        void transactIndexedHistory().then(
          ({ history }) => useBrowserHistoryStore.setState({ byProjectKey: history.byProjectKey }),
          () => undefined,
        );
      };
    }
    const hydrate = (history: PersistedBrowserHistory) => {
      useBrowserHistoryStore.setState((state) => ({
        byProjectKey: history.byProjectKey,
        projectKeyByThreadKey: migratePersistedThreadProjectKeys({
          projectKeyByThreadKey: {
            ...Object.fromEntries(
              Object.entries(
                migratePersistedThreadProjectKeys(history, history.byProjectKey),
              ).filter(([threadKey]) => !Object.hasOwn(state.projectKeyByThreadKey, threadKey)),
            ),
            ...state.projectKeyByThreadKey,
          },
        }),
      }));
    };
    void transactIndexedHistory((history) => history).then(
      ({ history }) => hydrate(history),
      () => hydrate(readLegacyHistory()),
    );
    import.meta.hot?.dispose(() => {
      historyChannel?.close();
      historyChannel = undefined;
      void historyDatabase?.then(
        (db) => db.close(),
        () => undefined,
      );
    });
  }

  return useBrowserHistoryStore;
}

export function mergeBrowserHistoryState(
  persistedState: unknown,
  currentState: BrowserHistoryStoreState,
): BrowserHistoryStoreState {
  const migrated = migratePersistedBrowserHistoryState(persistedState);
  return {
    ...currentState,
    ...migrated,
    projectKeyByThreadKey: migratePersistedThreadProjectKeys(persistedState, migrated.byProjectKey),
    pendingVisitsByThreadKey: {},
  };
}

function migratePersistedThreadProjectKeys(
  persistedState: unknown,
  byProjectKey?: Record<string, BrowserHistoryEntry[]>,
): Record<string, string> {
  if (!persistedState || typeof persistedState !== "object") return {};
  const raw = (persistedState as { projectKeyByThreadKey?: unknown }).projectKeyByThreadKey;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && (!byProjectKey || Object.hasOwn(byProjectKey, entry[1])),
  );
  return Object.fromEntries(entries.slice(-MAX_PERSISTED_THREAD_MAPPINGS));
}

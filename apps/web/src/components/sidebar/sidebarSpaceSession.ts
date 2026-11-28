import type { SidebarSpace } from "@t3tools/client-runtime/sidebar-spaces";
import { ScopedProjectRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import {
  readLocalStorageValue,
  subscribeLocalStorageKey,
  useLocalStorage,
} from "../../hooks/useLocalStorage";

export const SIDEBAR_SPACE_DEFINITIONS = "t3code:sidebar:spaces";
const ACTIVE = "t3code:sidebar:active-space";
export const EMPTY_SIDEBAR_SPACES: readonly SidebarSpace[] = [];
export const SidebarSpaceDefinitions = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    projectRefs: Schema.Array(ScopedProjectRef),
  }),
);
let activeCache: string | null | undefined;
export function readSpaceSessionStorage(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readActiveSidebarSpace(): SidebarSpace | null {
  const id = activeCache === undefined ? readSpaceSessionStorage(ACTIVE) : activeCache;
  if (id === null) return null;
  const spaces = readLocalStorageValue(
    SIDEBAR_SPACE_DEFINITIONS,
    EMPTY_SIDEBAR_SPACES,
    SidebarSpaceDefinitions,
  );
  return spaces.find((space) => space.id === id) ?? null;
}

export function readActiveSidebarSpaceId(): string | null {
  return readActiveSidebarSpace()?.id ?? null;
}

let switchSidebarSpace: ((id: string | null) => void) | null = null;
let openNewThreadInSpace: (() => void) | null = null;
export const sidebarSpaceCommands = {
  subscribeSwitch(handler: (id: string | null) => void) {
    switchSidebarSpace = handler;
    return () => {
      if (switchSidebarSpace === handler) switchSidebarSpace = null;
    };
  },
  switch(id: string | null) {
    switchSidebarSpace?.(id);
  },
  subscribe(handler: () => void) {
    openNewThreadInSpace = handler;
    return () => {
      if (openNewThreadInSpace === handler) openNewThreadInSpace = null;
    };
  },
  newThread() {
    if (readActiveSidebarSpaceId() === null) return false;
    openNewThreadInSpace?.();
    return true;
  },
};

const subscribers = new Set<() => void>();
export function subscribeActiveSidebarSpace(callback: () => void) {
  subscribers.add(callback);
  const unsubscribeDefinitions = subscribeLocalStorageKey(SIDEBAR_SPACE_DEFINITIONS, callback);
  return () => {
    subscribers.delete(callback);
    unsubscribeDefinitions();
  };
}

export function selectActiveSidebarSpace(id: string | null) {
  activeCache = id;
  try {
    if (id === null) sessionStorage.removeItem(ACTIVE);
    else sessionStorage.setItem(ACTIVE, id);
  } catch {
    /* Keep the value in this window when browser storage is unavailable. */
  }
  for (const callback of subscribers) callback();
}

/** The active Space, tinting the navigation while one is selected. */
export function useActiveSidebarSpace(): SidebarSpace | null {
  const id = useActiveSidebarSpaceId();
  const [spaces] = useLocalStorage(
    SIDEBAR_SPACE_DEFINITIONS,
    EMPTY_SIDEBAR_SPACES,
    SidebarSpaceDefinitions,
  );
  return spaces.find((space) => space.id === id) ?? null;
}

export function useActiveSidebarSpaceId(): string | null {
  return useSyncExternalStore(subscribeActiveSidebarSpace, readActiveSidebarSpaceId, () => null);
}

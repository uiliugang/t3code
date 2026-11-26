import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { View } from "react-native";

// RN Modals move native window focus and close the keyboard. Keep composer menus in-window.
type Entries = ReadonlyMap<number, ReactNode>;

let nextKey = 0;

function allocateKey() {
  return nextKey++;
}
function createOverlayStore() {
  const entries = new Map<number, ReactNode>();
  const listeners = new Set<() => void>();
  let snapshot: Entries = new Map();

  const emit = () => {
    snapshot = new Map(entries);
    for (const listener of listeners) listener();
  };
  return {
    set(key: number, node: ReactNode) {
      entries.set(key, node);
      emit();
    },
    remove(key: number) {
      entries.delete(key);
      emit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
  };
}

const OverlayStoreContext = createContext(createOverlayStore());

export function OverlayPortal(props: { readonly children: ReactNode }) {
  const [key] = useState(allocateKey);
  const store = use(OverlayStoreContext);

  // RN has no createPortal, so projecting into the out-of-tree host has to
  // happen after commit. No dependency array: re-project after every render so
  // the host always shows the current content (menus re-render while open —
  // drill-in, theme).
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- projects children into the out-of-tree overlay host store after every commit
  useEffect(() => {
    store.set(key, props.children);
  });

  // Removal is unmount-only: deleting on every re-projection would move the
  // entry to the end of the map and restack it above overlays opened later.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- removes this entry from the overlay host store on unmount
  useEffect(() => () => store.remove(key), [key, store]);

  return null;
}

export function OverlayPortalHost() {
  const store = use(OverlayStoreContext);
  const current = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  if (current.size === 0) {
    return null;
  }
  return (
    <View pointerEvents="box-none" className="absolute inset-0">
      {[...current.entries()].map(([key, node]) => (
        <View key={key} pointerEvents="box-none" className="absolute inset-0">
          {node}
        </View>
      ))}
    </View>
  );
}

export function OverlayPortalScope({ children }: { readonly children: ReactNode }) {
  const [store] = useState(createOverlayStore);
  return (
    <OverlayStoreContext value={store}>
      {children}
      <OverlayPortalHost />
    </OverlayStoreContext>
  );
}

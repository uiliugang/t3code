import type { EnvironmentId, ThreadPredictionInput } from "@t3tools/contracts";

export type ComposerPredictionTarget = ThreadPredictionInput & {
  readonly environmentId: EnvironmentId;
};

export function composerPredictionKey(target: ComposerPredictionTarget) {
  return JSON.stringify([target.environmentId, target.threadId, target.sourceRunId]);
}

export function createComposerPredictionController(
  request: (target: ComposerPredictionTarget) => Promise<string | null>,
) {
  let snapshot: { readonly key: string | null; readonly text: string | null } = {
    key: null,
    text: null,
  };
  let revision = 0;
  let currentKey: string | null = null;
  const requests = new Map<string, Promise<string | null>>();
  const dismissed = new Set<string>();
  const listeners = new Set<() => void>();
  const publish = (key: string | null, text: string | null) => {
    if (snapshot.key === key && snapshot.text === text) return;
    snapshot = { key, text };
    for (const listener of listeners) listener();
  };
  const clear = () => {
    revision++;
    currentKey = null;
    publish(null, null);
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    dismiss: (key: string) => {
      dismissed.add(key);
      if (currentKey === key) clear();
    },
    update: (target: ComposerPredictionTarget | null) => {
      const key = target ? composerPredictionKey(target) : null;
      if (key === currentKey) return;
      clear();
      if (!target || !key || dismissed.has(key)) return;
      let pending = requests.get(key);
      if (!pending) {
        pending = request(target);
        requests.set(key, pending);
        if (requests.size > 128) {
          const oldest = requests.keys().next().value!;
          requests.delete(oldest);
          dismissed.delete(oldest);
        }
      }
      currentKey = key;
      const requestRevision = revision;
      void pending
        .then((text) => {
          if (revision === requestRevision && currentKey === key) publish(key, text);
        })
        .catch(() => {});
    },
  };
}

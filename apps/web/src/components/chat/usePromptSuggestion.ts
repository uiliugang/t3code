import type { EnvironmentId, RunId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import type { Thread } from "../../types";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

// Dismissed suggestions, keyed by environment and run, shared by every mounted composer and kept
// across remounts. Run ids derive from thread ids, which can repeat across environments.
let dismissedKeys: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const subscribeDismissed = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const readDismissed = () => dismissedKeys;
const dismissKey = (environmentId: EnvironmentId, runId: RunId) => `${environmentId}\u0000${runId}`;

/**
 * The provider's predicted next prompt, while the run that produced it is the thread's latest
 * completed run and Escape has not dismissed it.
 */
export function usePromptSuggestion(
  environmentId: EnvironmentId,
  thread: Thread | undefined,
  allowed: boolean,
): { readonly suggestion: string | null; readonly dismiss: () => void } {
  // Older servers decode the missing setting as false, so true also proves the method exists.
  const config = useServerConfigs().get(environmentId);
  const enabled = allowed && config?.settings.promptSuggestionsEnabled === true;
  const { data } = useEnvironmentQuery(
    // A local draft has no run, and so no suggestion, until its first send.
    enabled && thread?.latestRun
      ? orchestrationEnvironment.v2.promptSuggestion({
          environmentId,
          input: { threadId: thread.id },
        })
      : null,
  );
  const dismissed = useSyncExternalStore(subscribeDismissed, readDismissed);
  const latestRun = thread?.latestRun;
  const offered =
    data && latestRun?.runId === data.runId && latestRun.status === "completed" ? data : null;
  return {
    suggestion:
      offered && !dismissed.has(dismissKey(environmentId, offered.runId)) ? offered.text : null,
    dismiss: () => {
      if (offered === null) return;
      dismissedKeys = new Set(dismissedKeys).add(dismissKey(environmentId, offered.runId));
      for (const listener of listeners) listener();
    },
  };
}

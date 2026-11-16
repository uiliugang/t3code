import { RegistryContext } from "@effect/atom-react";
import { prefetchRequirementIssues } from "@t3tools/client-runtime/state/requirement-board";
import type { EnvironmentId } from "@t3tools/contracts";
import { useContext, useEffect, useSyncExternalStore } from "react";

import { getDocumentActivity, subscribeDocumentActivity } from "../../lib/documentActivity";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { sourceControlEnvironment } from "../../state/sourceControl";

export function RequirementPrefetchCoordinator() {
  const environmentIds = useConnectedEnvironmentIds();
  const { visible } = useSyncExternalStore(subscribeDocumentActivity, getDocumentActivity);
  return visible
    ? environmentIds.map((environmentId) => (
        <EnvironmentRequirementPrefetch key={environmentId} environmentId={environmentId} />
      ))
    : null;
}

function EnvironmentRequirementPrefetch({ environmentId }: { environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- warms connected environments' first pages during idle time and releases requests on hide or disconnect
  useEffect(() => {
    const controller = new AbortController();
    const prefetch = () => {
      void prefetchRequirementIssues(
        registry,
        sourceControlEnvironment.issues,
        [environmentId],
        controller.signal,
      );
    };
    const idle = typeof window.requestIdleCallback === "function";
    const handle = idle
      ? window.requestIdleCallback(prefetch, { timeout: 2_000 })
      : window.setTimeout(prefetch, 200);
    return () => {
      if (idle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
      controller.abort();
    };
  }, [environmentId, registry]);
  return null;
}

import { RegistryContext } from "@effect/atom-react";
import { prefetchRequirementIssues } from "@t3tools/client-runtime/state/requirement-board";
import type { EnvironmentId } from "@t3tools/contracts";
import { useContext, useEffect } from "react";

import { useAppActive } from "../../lib/appState";
import { useEnvironments } from "../../state/environments";
import { sourceControlEnvironment } from "../../state/sourceControl";

export function RequirementPrefetchCoordinator() {
  const active = useAppActive();
  const { environments } = useEnvironments();
  return active
    ? environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => (
          <EnvironmentRequirementPrefetch
            key={environment.environmentId}
            environmentId={environment.environmentId}
          />
        ))
    : null;
}

function EnvironmentRequirementPrefetch({ environmentId }: { environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- preloads the first pages while the app is active and releases its readers on background or disconnect
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
    const handle = requestIdleCallback(prefetch, { timeout: 2_000 });
    return () => {
      cancelIdleCallback(handle);
      controller.abort();
    };
  }, [environmentId, registry]);
  return null;
}

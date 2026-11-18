import { RegistryContext } from "@effect/atom-react";
import { useAtomValue } from "@effect/atom-react";
import { prefetchRequirementIssues } from "@t3tools/client-runtime/state/requirement-board";
import { isMeituanServiceEnabled, type EnvironmentId } from "@t3tools/contracts";
import { useContext, useEffect } from "react";

import { useAppActive } from "../../lib/appState";
import { useEnvironments } from "../../state/environments";
import { issueEnvironment } from "../../state/issues";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { serverEnvironment } from "../../state/server";

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
  const meituanEnabled = isMeituanServiceEnabled(
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId)),
    "requirements",
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- preloads the first pages while the app is active and releases its readers on background or disconnect
  useEffect(() => {
    const controller = new AbortController();
    const prefetch = () => {
      void prefetchRequirementIssues(
        registry,
        sourceControlEnvironment.issues,
        [environmentId],
        controller.signal,
        () => meituanEnabled,
        (id) =>
          registry.get(serverEnvironment.configValueAtom(id))?.requirementIssueTrackers
            ? issueEnvironment.list
            : undefined,
      );
    };
    const handle = requestIdleCallback(prefetch, { timeout: 2_000 });
    return () => {
      cancelIdleCallback(handle);
      controller.abort();
    };
  }, [environmentId, registry, meituanEnabled]);
  return null;
}

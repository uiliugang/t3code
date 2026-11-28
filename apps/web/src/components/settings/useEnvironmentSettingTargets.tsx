import {
  AuthSettingsWriteScope,
  isManagedSettingPath,
  type ServerConfig,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useState } from "react";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { isConnectedWithConfig } from "./scopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";

export function supportsPeerLinks(environment: EnvironmentPresentation): boolean {
  return environment.serverConfig?.environment.capabilities.peerLinks === true;
}

export function resolveEnvironmentSettingSelection(
  candidates: readonly EnvironmentPresentation[],
  machine: string | undefined,
  primaryEnvironmentId: string | null,
): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!.environmentId;
  if (machine === undefined) return null;
  if (candidates.some((environment) => environment.environmentId === machine)) {
    return machine;
  }
  return (
    candidates.find(
      (environment) =>
        environment.environmentId === primaryEnvironmentId && isConnectedWithConfig(environment),
    )?.environmentId ??
    candidates.find(isConnectedWithConfig)?.environmentId ??
    candidates[0]?.environmentId ??
    null
  );
}

export function useEnvironmentSettingTargets(
  keys: readonly string[],
  includes: (environment: EnvironmentPresentation) => boolean = () => true,
) {
  const { environments } = useEnvironments();
  const { search } = useSettingsScope();
  const primary = usePrimaryEnvironmentId();
  const [saving, setSaving] = useState(false);
  const candidates = environments.filter(includes);
  const connected = candidates.filter(
    (environment): environment is EnvironmentPresentation & { serverConfig: ServerConfig } =>
      isConnectedWithConfig(environment),
  );
  const selected = resolveEnvironmentSettingSelection(candidates, search.machine, primary);
  const targets = connected.filter(
    (environment) => selected === null || selected === environment.environmentId,
  );
  const writable = useEnvironmentsWithScope(targets, AuthSettingsWriteScope);
  const managedBy = targets
    .map((environment) => environment.serverConfig.managedPolicy)
    .find((policy) => keys.some((key) => isManagedSettingPath(policy, key)))?.organization;
  const permitted =
    targets.length > 0 && targets.every((environment) => writable.has(environment.environmentId));
  const canWrite = permitted && !managedBy && !saving;
  const update = useAtomCommand(serverEnvironment.updateSettings);

  return {
    targets,
    permitted,
    managedBy,
    canWrite,
    save: (build: (settings: ServerSettings) => ServerSettingsPatch) => {
      if (!canWrite) return;
      setSaving(true);
      void Promise.allSettled(
        targets.map(({ environmentId, serverConfig }) =>
          update({ environmentId, input: { patch: build(serverConfig.settings) } }),
        ),
      ).finally(() => setSaving(false));
    },
  };
}

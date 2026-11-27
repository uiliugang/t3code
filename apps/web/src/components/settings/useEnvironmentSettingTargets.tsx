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
import { EnvironmentScopeMenu } from "./SettingsScopeSentence";

export function useEnvironmentSettingTargets(
  keys: readonly string[],
  includes: (environment: EnvironmentPresentation) => boolean = () => true,
) {
  const { environments } = useEnvironments();
  const { search } = useSettingsScope();
  const primary = usePrimaryEnvironmentId();
  const [selection, setSelection] = useState<string | null>();
  const [saving, setSaving] = useState(false);
  const candidates = environments.filter(includes);
  const connected = candidates.filter(
    (environment): environment is EnvironmentPresentation & { serverConfig: ServerConfig } =>
      isConnectedWithConfig(environment),
  );
  const selected =
    selection !== undefined
      ? selection
      : (search.machine ??
        connected.find((environment) => environment.environmentId === primary)?.environmentId ??
        connected[0]?.environmentId ??
        null);
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
  const picker =
    candidates.length > 0 ? (
      <EnvironmentScopeMenu
        groups={[]}
        environments={candidates}
        value={selected === null ? {} : { machine: selected }}
        onChange={(next) => setSelection(next.machine ?? null)}
        singleEnvironment={candidates.length === 1}
        variant="ghost"
      />
    ) : null;

  return {
    picker,
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

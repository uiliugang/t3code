import { useGT } from "gt-react";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import type { useEnvironmentSettingTargets } from "./useEnvironmentSettingTargets";

export function LinkedEnvironmentEnableSettings({
  settingTargets: { targets, canWrite, permitted, managedBy, save },
}: {
  settingTargets: ReturnType<typeof useEnvironmentSettingTargets>;
}) {
  const gt = useGT();
  const setting = useSearchableSetting()("linked-environments-beta");
  const checked = targets[0]?.serverConfig.settings.linkedEnvironmentsEnabled ?? false;
  const mixed = targets.some(
    ({ serverConfig }) => serverConfig.settings.linkedEnvironmentsEnabled !== checked,
  );

  return (
    <SettingsSection id="linked-environment-settings" title={gt("Linking between environments")}>
      <SettingsRow
        {...setting}
        description={gt(
          "Allow agents on the selected machines to work across linked environments. When disabled, running tasks finish and new tasks cannot start over a link.",
        )}
        managed={
          managedBy === undefined
            ? undefined
            : gt("Managed by {organization}.", { organization: managedBy })
        }
        status={
          targets.length === 0
            ? gt("Connect an environment that supports linking.")
            : !permitted
              ? gt(
                  "This connection lacks permission to change settings on the selected environment.",
                )
              : undefined
        }
        control={
          <Switch
            aria-label={gt("Enable linked environments")}
            checked={!mixed && checked}
            mixed={mixed}
            disabled={!canWrite}
            onCheckedChange={(value) => save(() => ({ linkedEnvironmentsEnabled: value }))}
          />
        }
      />
    </SettingsSection>
  );
}

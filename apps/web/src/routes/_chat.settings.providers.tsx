import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { ProviderEnvironmentActions } from "../components/ProviderUpdatesAction";

function SettingsProvidersRoute() {
  const target = Route.useSearch();
  const { environment, scope } = useSettingsScope();
  const gt = useGT();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? gt("Reconnect {label} to set up its providers.", { label: scope.label })
          : gt("Connect an environment to set up its providers.")}
      </p>
    );
  }
  const singleEnvironment =
    scope.kind === "environment" ||
    scope.kind === "checkout" ||
    (scope.kind === "project" && scope.environmentId !== null);
  const members = scope.kind === "project" || scope.kind === "checkout" ? scope.members : [];
  return (
    <ProviderSettingsPanel
      environmentId={environment.environmentId}
      environmentIds={scope.environmentIds}
      {...(target.instanceId ? { instanceId: target.instanceId } : {})}
      projectIdsByEnvironment={Object.fromEntries(
        scope.environmentIds.map((environmentId) => [
          environmentId,
          members
            .filter((member) => member.environmentId === environmentId)
            .map((member) => member.id),
        ]),
      )}
      {...(!singleEnvironment
        ? {
            headerAction: (
              <ProviderEnvironmentActions
                key={scope.environmentIds.join("\n")}
                environmentIds={scope.environmentIds}
              />
            ),
          }
        : {})}
      scoped={singleEnvironment}
    />
  );
}

export const Route = createFileRoute("/_chat/settings/providers")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  component: SettingsProvidersRoute,
});

import { EnvironmentId } from "@t3tools/contracts";
import { LayersIcon } from "lucide-react";
import { ProjectImportActions } from "./ProjectImportActions";

import { Button } from "../ui/button";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsPageContainer } from "./settingsLayout";
import { ALL_ENVIRONMENTS_VALUE, selectEnvironmentAxis } from "./settingsScopeAxis";
import { ProjectTypeFilterControl } from "./ProjectTypeFilterControl";
import { useUiTranslation } from "../../hooks/useUiTranslation";

export function ProjectsSettings() {
  const t = useUiTranslation();
  const { search: value, scope, selectScope } = useSettingsScope();
  const unavailable =
    scope.kind === "unavailable" ? (
      <SettingsPageContainer>
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">{scope.message}</p>
          {value.machine || value.checkout ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => selectScope(selectEnvironmentAxis(value, ALL_ENVIRONMENTS_VALUE))}
            >
              <LayersIcon />
              {t("Show all environments")}
            </Button>
          ) : null}
        </div>
      </SettingsPageContainer>
    ) : null;
  // Keep the panel mounted so it can follow members when regrouping changes the project key.
  const projectScope =
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    (scope.kind === "unavailable" &&
      (scope.reason === "project-missing" || scope.reason === "checkout-missing"));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {value.project && projectScope ? (
        <ProjectSettingsPanel
          projectKey={value.project}
          environmentId={value.machine ? EnvironmentId.make(value.machine) : null}
          checkoutKey={value.checkout ?? null}
          unavailable={unavailable}
        />
      ) : unavailable ? (
        unavailable
      ) : (
        <SettingsScopeNotice
          target="project"
          actions={
            <div className="flex flex-wrap items-center justify-between gap-3">
              <ProjectTypeFilterControl />
              <ProjectImportActions
                environmentId={value.machine ? EnvironmentId.make(value.machine) : undefined}
              />
            </div>
          }
        >
          {t("Choose a project or group to manage its name, icon, repositories and actions.")}
        </SettingsScopeNotice>
      )}
    </div>
  );
}

import type { EnvironmentId } from "@t3tools/contracts";
import { FolderPlusIcon, LayersIcon } from "lucide-react";
import { getProjectFolderImportLocations } from "@t3tools/client-runtime/operations/projects";
import type { Project } from "../../types";
import { openProjectFolderImport } from "../../projectFolderImport";
import { openCommandPalette } from "../../commandPaletteBus";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { Button } from "../ui/button";
import { openCreateWorkspace } from "../CreateWorkspaceDialog";
import { useSettingsScope } from "./SettingsScopeContext";

export function ProjectImportActions({
  environmentId,
  projects = [],
  projectTitle,
}: {
  environmentId?: EnvironmentId | undefined;
  projects?: ReadonlyArray<Project>;
  projectTitle?: string;
}) {
  const t = useUiTranslation();
  const { selectScope, setProjectTypeFilter, environment } = useSettingsScope();
  const targetEnvironmentId = environmentId ?? environment?.environmentId;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => openCommandPalette({ open: "add-project" })}
      >
        <FolderPlusIcon />
        {t("Add project")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          openCreateWorkspace({
            initialEnvironmentId: environmentId,
            onCreated: (project) => {
              setProjectTypeFilter("group");
              selectScope({ machine: project.environmentId });
            },
          })
        }
      >
        <LayersIcon />
        {t("Add group")}
      </Button>
      <Button
        size="sm"
        onClick={() =>
          openProjectFolderImport({
            ...(targetEnvironmentId ? { environmentId: targetEnvironmentId } : {}),
            ...(projectTitle ? { projectTitle } : {}),
            locations: getProjectFolderImportLocations(projects),
          })
        }
      >
        <FolderPlusIcon />
        {t("Import folders")}
      </Button>
    </div>
  );
}

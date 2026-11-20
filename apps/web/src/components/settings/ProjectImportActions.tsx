import type { EnvironmentId } from "@t3tools/contracts";
import { FolderPlusIcon } from "lucide-react";
import { getProjectFolderImportLocations } from "@t3tools/client-runtime/operations/projects";
import type { Project } from "../../types";
import { openProjectFolderImport } from "../../projectFolderImport";
import { openCommandPalette } from "../../commandPaletteBus";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { Button } from "../ui/button";
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
  const { environment } = useSettingsScope();
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

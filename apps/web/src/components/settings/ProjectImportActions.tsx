import type { EnvironmentId } from "@t3tools/contracts";
import { FolderPlusIcon, LayersIcon, PlusIcon } from "lucide-react";
import {
  getBrowseParentPath,
  ensureBrowseDirectoryPath,
} from "@t3tools/client-runtime/state/projects";
import { openProjectFolderImport } from "../../projectFolderImport";
import { openCommandPalette } from "../../commandPaletteBus";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { Button } from "../ui/button";
import { openCreateWorkspace } from "../CreateWorkspaceDialog";
import { useSettingsScope } from "./SettingsScopeContext";

export function ProjectImportActions({
  environmentId,
  workspaceRoot,
}: {
  environmentId?: EnvironmentId | undefined;
  workspaceRoot?: string | undefined;
}) {
  const t = useUiTranslation();
  const { selectScope, setProjectTypeFilter } = useSettingsScope();
  const siblingPath = workspaceRoot
    ? getBrowseParentPath(ensureBrowseDirectoryPath(workspaceRoot))
    : null;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {environmentId && siblingPath ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            openProjectFolderImport({
              environmentId,
              parentPath: siblingPath,
            })
          }
        >
          <FolderPlusIcon />
          {t("Import sibling folders")}
        </Button>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        onClick={() => openCommandPalette({ open: "add-project" })}
      >
        <PlusIcon />
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
        onClick={() => openProjectFolderImport(environmentId ? { environmentId } : {})}
      >
        <FolderPlusIcon />
        {t("Import folders")}
      </Button>
    </div>
  );
}

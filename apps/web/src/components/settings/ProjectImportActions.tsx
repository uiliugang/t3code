import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { FolderPlusIcon } from "lucide-react";
import { useGT } from "gt-react";
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
  const gt = useGT();
  const { environment, scope } = useSettingsScope();
  const targetEnvironmentId = environmentId ?? environment?.environmentId;
  // The representative for an all-environments scope is display-only.
  const importEnvironmentId =
    scope.environmentIds.length === 1 &&
    targetEnvironmentId !== undefined &&
    scope.environmentIds[0] === targetEnvironmentId &&
    environment?.environmentId === targetEnvironmentId
      ? targetEnvironmentId
      : undefined;
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
      {importEnvironmentId ? (
        <Button
          variant="outline"
          size="sm"
          render={<Link to="/welcome" hash={`projects:${importEnvironmentId}`} />}
        >
          {gt("Import projects and their threads")}
        </Button>
      ) : null}
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

import type { ProjectWorkspaceConfig } from "@t3tools/contracts";
import { formatProjectDisplayName } from "@t3tools/shared/projectPresentation";
import { useUiTranslation } from "../hooks/useUiTranslation";
import { useClientSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";

export function ProjectLabel({
  name,
  project,
  className,
}: {
  readonly name: string;
  readonly project?:
    | {
        readonly workspaceConfig?: ProjectWorkspaceConfig | undefined;
        readonly isScratch?: boolean;
      }
    | undefined;
  readonly className?: string;
}) {
  const t = useUiTranslation();
  const capitalize = useClientSettings((settings) => settings.capitalizeProjectNames);
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5", className)}>
      <span className="min-w-0 truncate">
        {project?.isScratch ? t("No project") : formatProjectDisplayName(name, capitalize)}
      </span>
    </span>
  );
}

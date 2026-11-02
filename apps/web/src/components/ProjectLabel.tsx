import type { ProjectWorkspaceConfig } from "@t3tools/contracts";
import { formatProjectDisplayName, projectDisplayKind } from "@t3tools/shared/projectPresentation";
import { useClientSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

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
  const capitalize = useClientSettings((settings) => settings.capitalizeProjectNames);
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5", className)}>
      <span className="min-w-0 truncate">{formatProjectDisplayName(name, capitalize)}</span>
      {project && !project.isScratch ? (
        <Badge variant="secondary" size="sm">
          {projectDisplayKind(project)}
        </Badge>
      ) : null}
    </span>
  );
}

import type { ProjectWorkspaceConfig } from "@t3tools/contracts";
import { formatProjectDisplayName, projectDisplayKind } from "@t3tools/shared/projectPresentation";
import { useUiTranslation } from "../hooks/useUiTranslation";
import { useClientSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

export function ProjectLabel({
  name,
  project,
  showKind = false,
  kindOverride,
  className,
}: {
  readonly name: string;
  readonly project?:
    | {
        readonly workspaceConfig?: ProjectWorkspaceConfig | undefined;
        readonly isScratch?: boolean;
      }
    | undefined;
  readonly showKind?: boolean;
  readonly kindOverride?: "repo" | "group" | undefined;
  readonly className?: string;
}) {
  const t = useUiTranslation();
  const capitalize = useClientSettings((settings) => settings.capitalizeProjectNames);
  const kind = kindOverride ?? (project ? projectDisplayKind(project) : undefined);
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5", className)}>
      <span className="min-w-0 truncate">
        {project?.isScratch ? t("No project") : formatProjectDisplayName(name, capitalize)}
      </span>
      {(showKind || kindOverride !== undefined) && !project?.isScratch && kind ? (
        <Badge variant="secondary" size="sm">
          {kind}
        </Badge>
      ) : null}
    </span>
  );
}

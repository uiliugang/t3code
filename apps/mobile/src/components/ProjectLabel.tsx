import type { ProjectWorkspaceConfig } from "@t3tools/contracts";
import { formatProjectDisplayName, projectDisplayKind } from "@t3tools/shared/projectPresentation";
import { View } from "react-native";
import { useProjectPresentation } from "../lib/useProjectPresentation";
import { cn } from "../lib/cn";
import { AppText } from "./ui/AppText";

export function ProjectLabel(props: {
  readonly name: string;
  readonly className?: string;
  readonly textClassName?: string;
  readonly project?:
    | {
        readonly workspaceConfig?: ProjectWorkspaceConfig | undefined;
        readonly isScratch?: boolean;
      }
    | undefined;
}) {
  const { capitalizeProjectNames } = useProjectPresentation();
  return (
    <View className={cn("min-w-0 shrink flex-row items-center gap-1.5", props.className)}>
      <AppText
        numberOfLines={1}
        className={cn("shrink text-sm text-foreground-muted", props.textClassName)}
      >
        {formatProjectDisplayName(props.name, capitalizeProjectNames)}
      </AppText>
      {props.project && !props.project.isScratch ? (
        <View className="rounded bg-subtle px-1 py-0.5">
          <AppText className="text-3xs text-foreground-muted">
            {projectDisplayKind(props.project)}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}

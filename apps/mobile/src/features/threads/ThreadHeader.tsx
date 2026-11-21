import { useUiTranslation } from "../../lib/useUiTranslation";
import { useNavigation } from "@react-navigation/native";
import { AuthOrchestrationReadScope, EnvironmentId, ThreadId } from "@t3tools/contracts";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { useEnvironmentScope } from "../../state/session";
import {
  useThreadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly onOpenTaskBoard?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
}) {
  const t = useUiTranslation();
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(String(props.gitControls.environmentId));
  const canHandoff = useEnvironmentScope(
    props.draft ? null : environmentId,
    AuthOrchestrationReadScope,
  );
  const goBack = useWorkspaceBackNavigation();
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = useThreadTerminalMenu(props.gitControls);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const actions: AppBarAction[] = props.hasThreadCwd
    ? [
        {
          accessibilityLabel: filesVisible ? t("Close files") : t("Open files"),
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        },
      ]
    : [];
  if (props.onOpenTaskBoard) {
    actions.push({
      accessibilityLabel: t("Requirements board"),
      icon: "checkmark.circle",
      onPress: props.onOpenTaskBoard,
    });
  }
  const menus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);
  if (canHandoff) {
    menus.push({
      title: t("More actions"),
      icon: "ellipsis",
      items: [
        {
          id: "handoff-to-machine",
          title: t("Continue on another machine"),
          icon: "arrow.left.arrow.right",
          onPress: () =>
            navigation.navigate("ThreadHandoff", {
              environmentId,
              threadId: ThreadId.make(String(props.gitControls.threadId)),
              title: props.title,
            }),
        },
      ],
    });
  }

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: t("Return to chat"),
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={actions}
      menus={menus}
      hideBottomBorder
    />
  );
}

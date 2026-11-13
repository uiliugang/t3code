import { useUiTranslation } from "../../../lib/useUiTranslation";
import { useNewTaskProjectDefaults } from "../use-new-task-project-defaults";
import { useThreadRepository } from "../../../state/use-thread-repository";
import {
  getBranchDisplayName,
  isMainOrMasterBranch,
  sanitizeFeatureBranchName,
} from "@t3tools/shared/git";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";

import { SheetHeader } from "../../../components/ui/SheetHeader";
import { FitSheet } from "../../../components/ui/FitSheet";
import { FormField, FormSection } from "../../../components/ui/FormSection";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListSection } from "../../../components/ui/ListSection";
import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { SheetActionButton } from "./gitSheetComponents";

type GitBranchesSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

export function GitBranchesSheet(_props: GitBranchesSheetProps) {
  const t = useUiTranslation();
  const navigation = useNavigation();
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const mainBranchOnly =
    useNewTaskProjectDefaults(selectedThreadProject).projectSettings.settings
      .newWorktreesMainBranchOnly;
  const liveRepository = useThreadRepository();
  const [resourceId] = useState(liveRepository.selectionTarget);
  const { selectedThreadCwd } = useSelectedThreadWorktree(resourceId);
  const gitState = useSelectedThreadGitState(resourceId);
  const gitActions = useSelectedThreadGitActions(resourceId);
  const { canChangeThreadBranch } = gitActions;

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.branch({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );

  const currentBranchLabel = gitStatus.data?.refName ?? selectedThread?.branch ?? "Detached HEAD";
  const currentWorktreePath = selectedThreadCwd;
  const availableBranches = gitState.selectedThreadBranches;
  const branchesLoading = gitState.selectedThreadBranchesLoading;
  const busy = gitState.gitOperationLabel !== null;

  const [newBranchName, setNewBranchName] = useState("");
  const [worktreeBaseBranchOverride, setWorktreeBaseBranchOverride] = useState<string | null>(null);
  const worktreeBaseBranch =
    worktreeBaseBranchOverride ??
    (mainBranchOnly
      ? (availableBranches.find((branch) => isMainOrMasterBranch(branch.name))?.name ?? "main")
      : currentBranchLabel === "Detached HEAD"
        ? "main"
        : currentBranchLabel);
  const [worktreeBranchName, setWorktreeBranchName] = useState("");

  return (
    <FitSheet
      header={<SheetHeader title={t("Branches & worktrees")} onClose={() => navigation.goBack()} />}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <FormSection title={t("New branch")}>
        <FormField
          value={newBranchName}
          onChangeText={setNewBranchName}
          placeholder="feature/mobile-polish"
          accessibilityLabel={t("New branch name")}
        />
        <SheetActionButton
          icon="plus"
          label={t("Create & checkout")}
          tone="primary"
          disabled={!canChangeThreadBranch || busy || newBranchName.trim().length === 0}
          onPress={() => {
            const branch = sanitizeFeatureBranchName(newBranchName.trim());
            if (branch.length === 0) return;
            void gitActions.onCreateSelectedThreadBranch(branch).then((result) => {
              if (result === null) return;
              setNewBranchName("");
              navigation.goBack();
            });
          }}
        />
      </FormSection>

      <FormSection title={t("New worktree")}>
        <FormField
          label={t("Base branch")}
          value={worktreeBaseBranch}
          onChangeText={setWorktreeBaseBranchOverride}
          placeholder="main"
          accessibilityLabel={t("Worktree base branch")}
        />
        <FormField
          label={t("New branch")}
          value={worktreeBranchName}
          onChangeText={setWorktreeBranchName}
          placeholder="feature/mobile-thread"
          accessibilityLabel={t("Worktree branch name")}
        />
        <SheetActionButton
          icon="square.split.2x1"
          label={t("Create worktree")}
          tone="primary"
          disabled={
            !canChangeThreadBranch ||
            busy ||
            worktreeBaseBranch.trim().length === 0 ||
            (mainBranchOnly &&
              !isMainOrMasterBranch(
                worktreeBaseBranch.trim(),
                availableBranches.find((branch) => branch.name === worktreeBaseBranch.trim())
                  ?.remoteName,
              )) ||
            worktreeBranchName.trim().length === 0
          }
          onPress={() => {
            const baseBranch = worktreeBaseBranch.trim();
            const newBranch = worktreeBranchName.trim();
            if (baseBranch.length === 0 || newBranch.length === 0) return;
            void gitActions
              .onCreateSelectedThreadWorktree({ baseBranch, newBranch })
              .then((result) => {
                if (result === null) return;
                setWorktreeBranchName("");
                navigation.goBack();
              });
          }}
        />
      </FormSection>

      <ListSection
        title={t("Existing branches")}
        footer={
          branchesLoading
            ? t("Loading branches...")
            : availableBranches.length === 0
              ? t("No local branches found.")
              : undefined
        }
      >
        {availableBranches.map((branch, index) => {
          const subtitle = branch.worktreePath
            ? branch.worktreePath === currentWorktreePath
              ? "Checked out in this thread"
              : "Checked out in another worktree"
            : branch.isDefault
              ? "Default branch"
              : "Local branch";

          return (
            <ListChoiceRow
              key={branch.name}
              label={getBranchDisplayName(branch)}
              description={t(subtitle)}
              selected={branch.current}
              separated={index > 0}
              disabled={!canChangeThreadBranch || busy}
              onPress={() => {
                void gitActions
                  .onCheckoutSelectedThreadBranch(branch.name, branch.worktreePath)
                  .then((result) => {
                    if (result === null) return;
                    navigation.goBack();
                  });
              }}
            />
          );
        })}
      </ListSection>
    </FitSheet>
  );
}

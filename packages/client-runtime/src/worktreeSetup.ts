import type {
  OrchestrationV2Run,
  WorktreeSetupSnapshot,
  WorktreeSetupStage,
} from "@t3tools/contracts";
import type { UiTranslator } from "@t3tools/shared/uiLocale";

export function worktreeFetchLabel(stage: WorktreeSetupStage, t: UiTranslator): string | null {
  if (stage.id !== "fetch" || stage.status !== "running" || !stage.fetchProgress) return null;
  const { remoteRefName, attempt, maxAttempts, retryReason } = stage.fetchProgress;
  if (retryReason === null) return t("Fetching {ref}", { ref: remoteRefName });
  const message =
    retryReason === "timeout"
      ? "No progress; retrying {ref} ({attempt}/{maxAttempts})"
      : retryReason === "network"
        ? "Connection failed; retrying {ref} ({attempt}/{maxAttempts})"
        : "Reference busy; retrying {ref} ({attempt}/{maxAttempts})";
  return t(message, { ref: remoteRefName, attempt, maxAttempts });
}

export function resolveVisibleWorktreeSetup(input: {
  live: WorktreeSetupSnapshot | null;
  recorded: WorktreeSetupSnapshot | null;
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "startedAt">>;
  followUpSent: boolean;
}): WorktreeSetupSnapshot | null {
  const snapshot =
    input.live && (!input.recorded || input.live.sequence >= input.recorded.sequence)
      ? input.live
      : input.recorded;
  if (!snapshot) return null;
  if (snapshot.phase === "running") return snapshot;
  if (input.followUpSent) return null;
  if (snapshot.phase !== "done") return snapshot;
  if (!input.runs.some((run) => run.startedAt !== null)) return snapshot;
  return snapshot.stages.some((stage) => stage.status === "failed") ? snapshot : null;
}

export function worktreeSetupAgentStarted(snapshot: WorktreeSetupSnapshot): boolean {
  return snapshot.stages.some((stage) => stage.id === "agent" && stage.status === "done");
}

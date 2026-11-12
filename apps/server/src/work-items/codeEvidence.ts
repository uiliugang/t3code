import type { OrchestrationV2ThreadProjection, RunId, WorkItemExecution } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function workItemCodeEvidence(
  execution: WorkItemExecution,
  records: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "checkpointScopes" | "checkpoints"
  >,
  runIds: ReadonlySet<RunId>,
  now: string,
) {
  const checkpoint = records.checkpoints
    .filter((entry) => entry.runId !== null && runIds.has(entry.runId) && entry.status === "ready")
    .toSorted(
      (a, b) => DateTime.toEpochMillis(b.capturedAt) - DateTime.toEpochMillis(a.capturedAt),
    )[0];
  const scope = checkpoint
    ? records.checkpointScopes.find((entry) => entry.id === checkpoint.scopeId)
    : records.checkpointScopes.find(
        (entry) => entry.kind === "root_run" && entry.runId !== null && runIds.has(entry.runId),
      );
  const unrelatedRuns = records.runs.some((run) => !runIds.has(run.id));
  const pendingWorktree =
    !checkpoint &&
    records.thread.worktreePath === null &&
    records.runs.some(
      (run) =>
        runIds.has(run.id) &&
        (run.status === "preparing" || run.status === "failed" || run.status === "interrupted") &&
        run.workspacePreparation?.type === "worktree",
    );
  const binding = scope?.workspace?.bindings.find(
    (entry) => entry.rootId === scope.workspace?.primaryRootId,
  );
  const workspacePath = pendingWorktree
    ? null
    : (scope?.cwd ??
      execution.resolvedWorkspacePath ??
      (unrelatedRuns
        ? null
        : (records.thread.worktreePath ?? records.thread.projectWorkspaceRoot ?? null)));
  const branch = pendingWorktree
    ? null
    : ((unrelatedRuns ? null : records.thread.branch) ??
      execution.branch ??
      binding?.launchBranch ??
      null);
  const changed = workspacePath !== execution.resolvedWorkspacePath || branch !== execution.branch;
  return {
    resolvedWorkspacePath: workspacePath,
    branch,
    checkpointId: checkpoint?.id ?? execution.checkpointId ?? null,
    checkpointRef: checkpoint?.ref ?? execution.checkpointRef ?? null,
    codeEvidenceCapturedAt: checkpoint
      ? DateTime.formatIso(checkpoint.capturedAt)
      : changed
        ? now
        : (execution.codeEvidenceCapturedAt ?? now),
  };
}

import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

export function threadPredictionSourceRun(
  thread:
    | Pick<
        OrchestrationV2ThreadShell,
        | "status"
        | "latestRunId"
        | "activeRunId"
        | "pendingRuntimeRequest"
        | "pendingBackgroundTasks"
        | "archivedAt"
        | "deletedAt"
        | "hasActionableProposedPlan"
      >
    | null
    | undefined,
) {
  return thread?.status === "completed" &&
    thread.activeRunId === null &&
    thread.pendingRuntimeRequest === null &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
    !thread.hasActionableProposedPlan &&
    thread.archivedAt === null &&
    thread.deletedAt === null
    ? thread.latestRunId
    : null;
}

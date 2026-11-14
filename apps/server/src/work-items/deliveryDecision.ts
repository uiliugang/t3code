import type { DeliveryEvidence, DeliveryScope, IssueProvider } from "@t3tools/contracts";

export function decideDelivery(
  provider: IssueProvider,
  scope: DeliveryScope,
  evidence: DeliveryEvidence,
) {
  if (evidence.anomaly !== null)
    return { progress: "delivery_exception", nextAction: "none" } as const;
  if (
    scope.confirmedRevision !== scope.revision ||
    scope.requiredPullRequests.length === 0 ||
    (provider === "meituan" && scope.changedServices.length === 0)
  )
    return { progress: "needs_confirmation", nextAction: "none" } as const;
  if (
    !scope.requiredPullRequests.every((url) =>
      evidence.pullRequests.some((pr) => pr.url === url && pr.merged),
    )
  )
    return { progress: "awaiting_merge", nextAction: "none" } as const;
  if (provider === "github")
    return { progress: "delivery_complete", nextAction: "complete_external" } as const;
  const covered = scope.changedServices.filter((service) =>
    evidence.releases.some(
      (release) =>
        release.completed &&
        release.appkey === service.appkey &&
        release.target === service.target &&
        release.revision === service.revision,
    ),
  ).length;
  if (covered === scope.changedServices.length)
    return { progress: "delivery_complete", nextAction: "complete_external" } as const;
  if (covered > 0) return { progress: "partially_released", nextAction: "create_mcm" } as const;
  if (evidence.planIds.length > 0 || evidence.releases.length > 0)
    return { progress: "awaiting_release", nextAction: "create_mcm" } as const;
  return { progress: "awaiting_plan", nextAction: "create_mcm" } as const;
}

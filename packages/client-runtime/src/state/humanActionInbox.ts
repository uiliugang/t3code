import type { EnvironmentId, OrchestrationV2PendingHumanActionSnapshot } from "@t3tools/contracts";
import type { ThreadStructure } from "./models.ts";

export type HumanActionTarget = OrchestrationV2PendingHumanActionSnapshot["targets"][number];
export type ScopedHumanAction = HumanActionTarget & { readonly environmentId: EnvironmentId };

type HumanActionIdentity = Pick<
  HumanActionTarget,
  "threadId" | "requestId" | "targetItemId" | "kind"
>;

export function sameHumanAction(a: HumanActionIdentity, b: HumanActionIdentity): boolean {
  return (
    a.threadId === b.threadId &&
    a.requestId === b.requestId &&
    a.targetItemId === b.targetItemId &&
    a.kind === b.kind
  );
}

export function collectHumanActions(
  hosts: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly targets: readonly HumanActionTarget[];
  }>,
) {
  const unique = new Map<string, ScopedHumanAction>();
  for (const { environmentId, targets } of hosts) {
    for (const target of targets) {
      const key = JSON.stringify([environmentId, target.threadId, target.kind, target.requestId]);
      if (!unique.has(key)) unique.set(key, { ...target, environmentId });
    }
  }
  return [...unique.values()].sort(
    (a, b) =>
      Number(a.kind !== "approval") - Number(b.kind !== "approval") ||
      a.createdAt.epochMilliseconds - b.createdAt.epochMilliseconds,
  );
}

export function hasLiveHumanAction(
  projection: Pick<ThreadStructure, "thread" | "runtimeRequests" | "turnItems">,
  target: HumanActionIdentity,
) {
  const approval = target.kind === "approval";
  return (
    projection.thread.id === target.threadId &&
    projection.runtimeRequests.some(
      (request) =>
        request.id === target.requestId &&
        request.status === "pending" &&
        (approval
          ? request.kind !== "user_input" && request.responseCapability.type === "live"
          : request.kind === "user_input" && request.responseCapability.type !== "not_resumable"),
    ) &&
    projection.turnItems.some(
      (item) =>
        item.threadId === target.threadId &&
        item.id === target.targetItemId &&
        (item.status === "waiting" || item.status === "pending") &&
        (item.type === "approval_request" || item.type === "user_input_request") &&
        item.type === (approval ? "approval_request" : "user_input_request") &&
        item.requestId === target.requestId,
    )
  );
}

import {
  ProviderRequestKind,
  type EnvironmentId,
  type OrchestrationV2PendingHumanActionSnapshot,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ThreadStructure } from "./models.ts";

export type HumanActionTarget = OrchestrationV2PendingHumanActionSnapshot["targets"][number];
export type ScopedHumanAction = HumanActionTarget & { readonly environmentId: EnvironmentId };

type HumanActionIdentity = Pick<
  HumanActionTarget,
  "threadId" | "projectId" | "requestId" | "targetItemId" | "kind"
>;

export function sameHumanAction(a: HumanActionIdentity, b: HumanActionIdentity): boolean {
  return (
    a.threadId === b.threadId &&
    a.projectId === b.projectId &&
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

export function readHumanActionSnapshot<E>(
  result: AsyncResult.AsyncResult<OrchestrationV2PendingHumanActionSnapshot | null, E> | undefined,
) {
  // A successful stream result keeps waiting=true while the subscription is open.
  return result && AsyncResult.isSuccess(result) ? result.value : null;
}

export function humanActionSnapshotStatus<E>(
  result: AsyncResult.AsyncResult<OrchestrationV2PendingHumanActionSnapshot | null, E>,
  target: HumanActionIdentity,
) {
  if (AsyncResult.isFailure(result)) return "unavailable";
  const snapshot = readHumanActionSnapshot(result);
  if (snapshot === null) return "checking";
  return snapshot.targets.some((candidate) => sameHumanAction(candidate, target))
    ? "ready"
    : "unavailable";
}

export function hasLiveHumanAction(
  projection: Pick<ThreadStructure, "runtimeRequests" | "turnItems"> & {
    readonly thread: Pick<
      ThreadStructure["thread"],
      "id" | "projectId" | "archivedAt" | "deletedAt"
    >;
  },
  target: HumanActionIdentity,
) {
  const thread = projection.thread;
  if (
    thread.id !== target.threadId ||
    thread.projectId !== target.projectId ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null
  )
    return false;
  const approval = target.kind === "approval";
  const request = projection.runtimeRequests.find((request) => request.id === target.requestId);
  if (
    !request ||
    request.status !== "pending" ||
    (approval
      ? !ProviderRequestKind.literals.some((kind) => kind === request.kind) ||
        request.responseCapability.type !== "live"
      : request.kind !== "user_input" || request.responseCapability.type === "not_resumable")
  )
    return false;
  return projection.turnItems.some(
    (item) =>
      item.threadId === target.threadId &&
      item.id === target.targetItemId &&
      item.nodeId === request.nodeId &&
      (item.status === "waiting" || item.status === "pending") &&
      (item.type === "approval_request" || item.type === "user_input_request") &&
      item.type === (approval ? "approval_request" : "user_input_request") &&
      item.requestId === target.requestId,
  );
}

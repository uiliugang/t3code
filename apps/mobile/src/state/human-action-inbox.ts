import { useAtomValue } from "@effect/atom-react";
import {
  humanActionSnapshotStatus,
  verifyPendingHumanAction,
  type ScopedHumanAction,
} from "@t3tools/client-runtime/state/human-action-inbox";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type OrchestrationV2PendingHumanActionSnapshot,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { appAtomRegistry } from "./atom-registry";
import { orchestrationEnvironment } from "./orchestration";
import { serverEnvironment } from "./server";
import { readEnvironmentScope } from "./session";
import { workspaceConnections } from "./workspace";

export type MobileHumanActionTarget = Omit<ScopedHumanAction, "createdAt">;
const inbox = (environmentId: EnvironmentId, activation?: string) =>
  orchestrationEnvironment.v2.pendingHumanActions({
    environmentId,
    input: activation === undefined ? {} : { activation },
  });
const empty = Atom.make(AsyncResult.initial<OrchestrationV2PendingHumanActionSnapshot | null>());
export const mobileInboxes = Atom.family((ids: string) =>
  Atom.make((get) => (JSON.parse(ids) as EnvironmentId[]).map((id) => get(inbox(id)))),
);

function canVerify(environmentId: EnvironmentId) {
  if (
    !appAtomRegistry
      .get(workspaceConnections.environmentsAtom)
      .some(
        (environment) =>
          environment.environmentId === environmentId &&
          environment.isEnabled &&
          environment.connectionState === "connected",
      ) ||
    !readEnvironmentScope(environmentId, AuthOrchestrationReadScope) ||
    !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
    appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .pendingHumanActions !== true
  )
    return false;
  return true;
}

export async function openableMobileHumanAction(
  target: ScopedHumanAction,
  activation: string,
  signal: AbortSignal,
) {
  const { environmentId } = target;
  return (
    canVerify(environmentId) &&
    (await verifyPendingHumanAction(
      appAtomRegistry,
      inbox(environmentId, activation),
      target,
      signal,
    )) &&
    !signal.aborted &&
    canVerify(environmentId)
  );
}

export function useLiveMobileHumanAction(
  target: (MobileHumanActionTarget & { readonly activation: string }) | null,
) {
  const connected = useAtomValue(
    workspaceConnections.environmentsAtom,
    (environments) =>
      target !== null &&
      environments.some(
        (environment) =>
          environment.environmentId === target.environmentId &&
          environment.isEnabled &&
          environment.connectionState === "connected",
      ),
  );
  const result = useAtomValue(
    connected && target ? inbox(target.environmentId, target.activation) : empty,
  );
  return connected && target !== null ? humanActionSnapshotStatus(result, target) : "unavailable";
}

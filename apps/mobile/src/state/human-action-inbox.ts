import { useAtomValue } from "@effect/atom-react";
import {
  sameHumanAction,
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
const inbox = (environmentId: EnvironmentId) =>
  orchestrationEnvironment.v2.pendingHumanActions({ environmentId, input: {} });
const empty = Atom.make(AsyncResult.initial<OrchestrationV2PendingHumanActionSnapshot | null>());
export const mobileInboxes = Atom.family((ids: string) =>
  Atom.make((get) => (JSON.parse(ids) as EnvironmentId[]).map((id) => get(inbox(id)))),
);

export function openableMobileHumanAction(target: ScopedHumanAction) {
  const { environmentId } = target;
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
  const result = appAtomRegistry.get(inbox(environmentId));
  return (
    AsyncResult.isSuccess(result) &&
    !result.waiting &&
    result.value?.targets.some((candidate) => sameHumanAction(candidate, target)) === true
  );
}

export function useLiveMobileHumanAction(target: MobileHumanActionTarget | null) {
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
  const result = useAtomValue(connected && target ? inbox(target.environmentId) : empty);
  if (!connected || target === null || AsyncResult.isFailure(result)) return "unavailable";
  if (!AsyncResult.isSuccess(result) || result.waiting || result.value === null) return "checking";
  return result.value.targets.some((candidate) => sameHumanAction(candidate, target))
    ? "ready"
    : "unavailable";
}

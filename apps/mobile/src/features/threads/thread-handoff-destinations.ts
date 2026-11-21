import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { environmentProjects } from "../../state/projects";
import { environmentSession, sessionHasScope, useEnvironmentScope } from "../../state/session";

export function isHandoffProject(project: { archivedAt?: unknown; isScratch?: boolean } | null) {
  return project !== null && project.archivedAt == null && !project.isScratch;
}

export const handoffDestinationIdsAtom = Atom.make((get) => {
  const projectEnvironmentIds = new Set(
    get(environmentProjects.projectsAtom)
      .filter(isHandoffProject)
      .map((project) => project.environmentId),
  );
  return get(connectedEnvironmentIdsAtom).filter(
    (environmentId) =>
      projectEnvironmentIds.has(environmentId) &&
      sessionHasScope(
        get(environmentSession.sessionStateAtom(environmentId)),
        AuthOrchestrationOperateScope,
      ),
  );
});

export function useCanHandoffThread(source: EnvironmentId | null): boolean {
  const canRead = useEnvironmentScope(source, AuthOrchestrationReadScope);
  const hasDestination = useAtomValue(
    handoffDestinationIdsAtom,
    (destinations) => source !== null && destinations.some((destination) => destination !== source),
  );
  return canRead && hasDestination;
}

import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2PendingHumanActionSnapshot,
} from "@t3tools/contracts";
import { createOrchestrationEnvironmentAtoms } from "@t3tools/client-runtime/state/orchestration";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentShell } from "./shell";

export const orchestrationEnvironment = createOrchestrationEnvironmentAtoms(connectionAtomRuntime, {
  shellState: environmentShell.stateValueAtom,
});

export const threadTitlesRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:orchestration:thread-titles-read",
  tag: ORCHESTRATION_V2_WS_METHODS.getThreadTitles,
});

const emptyPendingHumanActionsAtom = Atom.make(
  AsyncResult.initial<OrchestrationV2PendingHumanActionSnapshot | null>(),
);

export const pendingHumanActionsAtom = (
  environmentId: EnvironmentId | null,
  activation?: string,
) =>
  environmentId === null
    ? emptyPendingHumanActionsAtom
    : orchestrationEnvironment.v2.pendingHumanActions({
        environmentId,
        input: activation === undefined ? {} : { activation },
      });

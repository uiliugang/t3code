import { useAtomValue, RegistryContext } from "@effect/atom-react";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  composerPredictionKey,
  createComposerPredictionController,
} from "@t3tools/client-runtime/composer-prediction";
import { threadPredictionSourceRun } from "@t3tools/shared/threadPrediction";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";

export function useComposerPrediction(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly thread: EnvironmentThreadShell | null;
  readonly enabled: boolean;
}) {
  const registry = useContext(RegistryContext);
  const canPredict = useAtomValue(
    orchestrationEnvironment.predictMessage.permissionAtom(input.environmentId),
  );
  const config = useAtomValue(serverEnvironment.configValueAtom(input.environmentId));
  const [controller] = useState(() =>
    createComposerPredictionController(async ({ environmentId, ...request }) => {
      const result = await runAtomCommand(
        registry,
        orchestrationEnvironment.predictMessage,
        { environmentId, input: request },
        { reportFailure: false, reportDefect: false },
      );
      return result._tag === "Success" ? result.value.text : null;
    }),
  );
  const sourceRunId = threadPredictionSourceRun(input.thread?.source);
  const enabled = input.enabled && canPredict && config?.threadPredictions === true;
  const { environmentId, threadId } = input;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes the prediction request lifecycle with the active composer and server capability
  useEffect(() => {
    controller.update(enabled && sourceRunId ? { environmentId, threadId, sourceRunId } : null);
  }, [controller, enabled, environmentId, threadId, sourceRunId]);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const key = sourceRunId ? composerPredictionKey({ environmentId, threadId, sourceRunId }) : null;
  return {
    text: enabled && key === snapshot.key ? snapshot.text : null,
    dismiss: () => {
      if (key) controller.dismiss(key);
    },
  };
}

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { AsyncResult } from "effect/reactivity";
import {
  composerPredictionKey,
  createComposerPredictionController,
} from "@t3tools/client-runtime/composer-prediction";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { threadPredictionSourceRun } from "@t3tools/shared/threadPrediction";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { orchestrationEnvironment } from "../../state/orchestration";
import { mobilePreferencesAtom } from "../../state/preferences";

export function useComposerPrediction(thread: EnvironmentThreadShell, available: boolean) {
  const registry = useContext(RegistryContext);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const canPredict = useAtomValue(
    orchestrationEnvironment.predictMessage.permissionAtom(thread.environmentId),
  );
  const enabled =
    available &&
    canPredict &&
    AsyncResult.isSuccess(preferences) &&
    preferences.value.showPredictedMessages === true;
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
  const sourceRunId = threadPredictionSourceRun(thread.source);
  const { environmentId, id: threadId } = thread;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes the request lifecycle with the visible mobile composer and its current thread
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

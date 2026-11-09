import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { AsyncResult } from "effect/reactivity";
import {
  composerPredictionKey,
  createComposerPredictionController,
  resolveComposerPredictionSource,
} from "@t3tools/client-runtime/composer-prediction";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { threadPredictionSourceRun } from "@t3tools/shared/threadPrediction";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ServerConfig as T3ServerConfig } from "@t3tools/contracts";
import { orchestrationEnvironment } from "../../state/orchestration";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useEnvironmentQuery } from "../../state/query";

export function useComposerPrediction(
  thread: EnvironmentThreadShell,
  available: boolean,
  config: T3ServerConfig | null,
) {
  const registry = useContext(RegistryContext);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const canPredict = useAtomValue(
    orchestrationEnvironment.predictMessage.permissionAtom(thread.environmentId),
  );
  const source = resolveComposerPredictionSource({
    driver: config?.providers.find(
      (provider) => provider.instanceId === thread.modelSelection.instanceId,
    )?.driver,
    nativeEnabled: config?.settings.promptSuggestionsEnabled === true,
    textGenerationEnabled:
      config?.threadPredictions === true &&
      canPredict &&
      AsyncResult.isSuccess(preferences) &&
      preferences.value.showPredictedMessages === true,
  });
  const enabled = available && source !== null;
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
  const [dismissedNativeKeys, setDismissedNativeKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const { data: nativeSuggestion } = useEnvironmentQuery(
    enabled && source === "native" && sourceRunId
      ? orchestrationEnvironment.v2.promptSuggestion({ environmentId, input: { threadId } })
      : null,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes the request lifecycle with the visible mobile composer and its current thread
  useEffect(() => {
    controller.update(
      enabled && source === "text-generation" && sourceRunId
        ? { environmentId, threadId, sourceRunId }
        : null,
    );
  }, [controller, enabled, source, environmentId, threadId, sourceRunId]);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const key = sourceRunId ? composerPredictionKey({ environmentId, threadId, sourceRunId }) : null;
  return {
    text:
      !enabled || key === null
        ? null
        : source === "native"
          ? nativeSuggestion?.runId === sourceRunId && !dismissedNativeKeys.has(key)
            ? nativeSuggestion.text
            : null
          : key === snapshot.key
            ? snapshot.text
            : null,
    dismiss: () => {
      if (!key) return;
      if (source === "native") setDismissedNativeKeys((current) => new Set(current).add(key));
      else controller.dismiss(key);
    },
  };
}

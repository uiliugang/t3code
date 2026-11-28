import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { AsyncResult } from "effect/reactivity";
import {
  composerPredictionKey,
  createComposerPredictionController,
  resolveComposerPredictionSource,
} from "@t3tools/client-runtime/composer-prediction";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { threadPredictionSourceRun } from "@t3tools/shared/threadPrediction";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  resolvePromptSuggestionPreference,
  type ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
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
  const legacyModelEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.showPredictedMessages === true;
  const useFallback =
    canPredict && config?.threadPredictions === true && config.promptSuggestionFallback === true;
  const source = resolveComposerPredictionSource({
    driver: config?.providers.find(
      (provider) => provider.instanceId === thread.modelSelection.instanceId,
    )?.driver,
    nativeEnabled: config?.settings.promptSuggestionsEnabled === true,
    preference: config?.settings.promptSuggestionPreference,
    textGenerationEnabled: config?.threadPredictions === true && canPredict && legacyModelEnabled,
  });
  const useNative = !useFallback && source === "native";
  const enabled =
    available &&
    (useFallback
      ? resolvePromptSuggestionPreference(config.settings, legacyModelEnabled).enabled
      : useNative ||
        (source === "text-generation" && canPredict && config?.threadPredictions === true));
  const [controller] = useState(() =>
    createComposerPredictionController(async ({ environmentId, ...request }) => {
      const result = await runAtomCommand(
        registry,
        orchestrationEnvironment.predictMessage,
        { environmentId, input: request },
        { reportFailure: false, reportDefect: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value.text;
    }),
  );
  const sourceRunId = threadPredictionSourceRun(thread.source);
  const { environmentId, id: threadId } = thread;
  const target = sourceRunId && {
    environmentId,
    threadId,
    sourceRunId,
    ...(useFallback ? { suggestionFallback: { legacyModelEnabled } } : {}),
  };
  const [dismissedNativeKeys, setDismissedNativeKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const { data: nativeSuggestion } = useEnvironmentQuery(
    enabled && useNative && sourceRunId
      ? orchestrationEnvironment.v2.promptSuggestion({ environmentId, input: { threadId } })
      : null,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes the request lifecycle with the visible mobile composer and its current thread
  useEffect(() => {
    controller.update(enabled && !useNative ? target : null);
  }, [controller, enabled, useNative, target]);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const key = target ? composerPredictionKey(target) : null;
  return {
    text:
      !enabled || key === null
        ? null
        : useNative
          ? nativeSuggestion?.runId === sourceRunId && !dismissedNativeKeys.has(key)
            ? nativeSuggestion.text
            : null
          : key === snapshot.key
            ? snapshot.text
            : null,
    dismiss: () => {
      if (!key) return;
      if (useNative) setDismissedNativeKeys((current) => new Set(current).add(key));
      else controller.dismiss(key);
    },
  };
}

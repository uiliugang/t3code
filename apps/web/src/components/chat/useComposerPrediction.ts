import { useAtomValue, RegistryContext } from "@effect/atom-react";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import {
  resolvePromptSuggestionPreference,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  composerPredictionKey,
  createComposerPredictionController,
} from "@t3tools/client-runtime/composer-prediction";
import { threadPredictionSourceRun } from "@t3tools/shared/threadPrediction";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";

export function useComposerPrediction(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly thread: EnvironmentThreadShell | null;
  readonly allowed: boolean;
  readonly legacyModelEnabled: boolean;
  readonly legacyModelSelected: boolean;
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
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value.text;
    }),
  );
  const sourceRunId = threadPredictionSourceRun(input.thread?.source);
  const useFallback =
    canPredict &&
    sourceRunId !== null &&
    config?.threadPredictions === true &&
    config.promptSuggestionFallback === true;
  const { legacyModelEnabled } = input;
  const enabled =
    input.allowed &&
    canPredict &&
    config?.threadPredictions === true &&
    (useFallback
      ? resolvePromptSuggestionPreference(config.settings, legacyModelEnabled).enabled
      : input.legacyModelSelected);
  const { environmentId, threadId } = input;
  const target = sourceRunId && {
    environmentId,
    threadId,
    sourceRunId,
    ...(useFallback ? { suggestionFallback: { legacyModelEnabled } } : {}),
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes the prediction request lifecycle with the active composer and server capability
  useEffect(() => {
    controller.update(enabled ? target : null);
  }, [controller, enabled, target]);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const key = target ? composerPredictionKey(target) : null;
  return {
    useFallback,
    text: enabled && key === snapshot.key ? snapshot.text : null,
    dismiss: () => {
      if (key) controller.dismiss(key);
    },
  };
}

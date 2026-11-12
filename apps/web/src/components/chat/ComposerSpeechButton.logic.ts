import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import type { UiTranslator } from "@t3tools/shared/uiLocale";

export function resolveSpeechPresentation(
  state: VoiceInputState,
  progress: { downloaded: number; total: number } | null,
  t: UiTranslator,
): { status: string | null; active: boolean } {
  switch (state.phase) {
    case "idle":
      return { status: null, active: false };
    case "error":
      return { status: t(state.error ?? "Voice input failed"), active: false };
    case "preparing":
      return {
        status: progress
          ? t("Downloading model {progress}%", {
              progress: Math.round((progress.downloaded / Math.max(1, progress.total)) * 100),
            })
          : t("Starting…"),
        active: true,
      };
    case "recording":
      return { status: t("Recording"), active: true };
    case "transcribing":
      return { status: t("Transcribing…"), active: true };
    case "post-processing":
      return { status: t("Cleaning up…"), active: true };
  }
}

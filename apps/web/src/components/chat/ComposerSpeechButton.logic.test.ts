import { expect, it } from "vite-plus/test";
import { translateUi } from "@t3tools/shared/uiLocale";
import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { resolveSpeechPresentation } from "./ComposerSpeechButton.logic";

it.each(["en", "zh-CN"] as const)(
  "localizes speech phases and download progress in %s",
  (language) => {
    const t = translateUi.bind(null, language);
    const phases: VoiceInputState["phase"][] = [
      "preparing",
      "recording",
      "transcribing",
      "post-processing",
    ];
    const expected =
      language === "en"
        ? ["Starting…", "Recording", "Transcribing…", "Cleaning up…"]
        : ["正在启动…", "正在录音", "正在转写…", "正在整理转写结果…"];
    for (const [index, phase] of phases.entries()) {
      expect(resolveSpeechPresentation({ phase, error: null, errorAction: null }, null, t)).toEqual(
        { status: expected[index], active: true },
      );
    }
    expect(
      resolveSpeechPresentation(
        { phase: "preparing", error: null, errorAction: null },
        { downloaded: 1, total: 4 },
        t,
      ).status,
    ).toBe(language === "en" ? "Downloading model 25%" : "正在下载模型 25%");
    expect(
      resolveSpeechPresentation(
        { phase: "error", error: "gateway says: retry", errorAction: null },
        null,
        t,
      ),
    ).toEqual({ status: "gateway says: retry", active: false });
    expect(
      resolveSpeechPresentation({ phase: "idle", error: null, errorAction: null }, null, t),
    ).toEqual({ status: null, active: false });
  },
);

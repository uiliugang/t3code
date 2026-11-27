import { expect, it } from "vite-plus/test";

import { translateUi } from "@t3tools/shared/uiLocale";
import { resolveSpeechPresentation } from "./ComposerSpeechButton.logic";

it("keeps a model download below 100 percent while preparing", () => {
  const state = { phase: "preparing", error: null, errorAction: null } as const;
  expect(
    resolveSpeechPresentation(state, { downloaded: 995, total: 1_000 }, translateUi.bind(null, "en")).status,
  ).toBe("Downloading model 99%");
});

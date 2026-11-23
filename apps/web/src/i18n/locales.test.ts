import { describe, expect, it } from "vite-plus/test";

import { resolveWebLocaleSelection } from "./locales";

describe("resolveWebLocaleSelection", () => {
  it.each([
    ["system", ["en-GB"], "en", undefined],
    ["system", ["zh-TW", "en-GB"], "en", undefined],
    ["en", ["en-GB"], "en", undefined],
    ["en", ["zh-CN"], "en", "en"],
    ["zh", ["en-US"], "zh", "zh"],
  ] as const)("%s with browser languages %j", (language, browserLocales, catalog, formatting) => {
    expect(resolveWebLocaleSelection(language, browserLocales)).toEqual({
      catalogLocale: catalog,
      formattingLocale: formatting,
    });
  });
});

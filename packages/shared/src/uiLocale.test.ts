import { describe, expect, it } from "vite-plus/test";
import { translateUi } from "./uiLocale.ts";

describe("UI translations", () => {
  it("switches both ways without translating missing messages or user content", () => {
    expect(translateUi("zh-CN", "Appearance")).toBe("外观");
    expect(translateUi("en", "Appearance")).toBe("Appearance");
    expect(translateUi("zh-CN", "my-project <script> & gpt-6")).toBe("my-project <script> & gpt-6");
    expect(translateUi("zh-CN", "Untranslated new feature")).toBe("Untranslated new feature");
    expect(translateUi("zh-CN", "")).toBe("");
  });
});

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

  it.each([
    ["Authenticated", "已认证"],
    ["Source control providers", "代码托管平台"],
    ["Wait for the full response", "等待完整回复"],
    ["Open command palette", "打开命令面板"],
    ["Search models...", "搜索模型…"],
  ])("translates settings and action text: %s", (message, translated) => {
    expect(translateUi("zh-CN", message)).toBe(translated);
    expect(translateUi("en", message)).toBe(message);
  });

  it("interpolates translated UI messages without translating their values", () => {
    const values = { name: "Projects {count} <script>", count: 2 };
    expect(translateUi("zh-CN", "Toggle {name} details", values)).toBe(
      "展开或收起 Projects {count} <script> 详情",
    );
    expect(translateUi("en", "Toggle {name} details", values)).toBe(
      "Toggle Projects {count} <script> details",
    );
    expect(translateUi("zh-CN", "Unknown {name} {missing}", values)).toBe(
      "Unknown Projects {count} <script> {missing}",
    );
  });
});

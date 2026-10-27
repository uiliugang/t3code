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
    ["Summary", "摘要"],
    ["Timeline", "时间线"],
    ["Reviewers", "评审人"],
    ["Description", "描述"],
    ["Merge", "合并"],
    ["Check out", "检出"],
    ["Reviewing", "待我评审"],
    ["Newest first", "最新优先"],
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

  it("formats pull request counts and keeps branch names verbatim", () => {
    expect(translateUi("zh-CN", "{count} of {total} failing", { count: 1, total: 9 })).toBe(
      "9 项检查中 1 项失败",
    );
    expect(translateUi("en", "{count} of {total} failing", { count: 1, total: 9 })).toBe(
      "1 of 9 failing",
    );
    expect(translateUi("zh-CN", "Conflicts with {branch}", { branch: "Summary/{count}" })).toBe(
      "与 Summary/{count} 冲突",
    );
    expect(translateUi("zh-CN", "Comments ({count})", { count: 0 })).toBe("评论（0）");
  });
});

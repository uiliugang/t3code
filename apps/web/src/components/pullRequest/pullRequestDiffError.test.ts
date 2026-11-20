import { describe, expect, it } from "vite-plus/test";
import { getTranslationsSnapshot, initializeGT } from "gt-react";
import { m, setActiveLocale } from "~/i18n/messages";
import zhTranslations from "~/i18n/translations/zh.json";

import { describePullRequestDiffError } from "./pullRequestDiffError";

describe("describePullRequestDiffError", () => {
  it("explains the rate limit inside an HTTP transport error without exposing the endpoint", () => {
    const error =
      "Failed to fetch remote environment endpoint http://127.0.0.1:49477/api/pull-requests/diff (PullRequestOperationError: Pull request operation diff failed: github requests to github.com are paused until the rate limit resets.).";
    const result = describePullRequestDiffError(error, "GitHub", "pr");

    expect(result.title).toBe("GitHub rate limit reached");
    expect(result.description).toContain("after the limit resets");
    expect(result.description).not.toContain("127.0.0.1");
    expect(result.description).not.toContain("PullRequestOperationError");
  });

  // regression: #19945 diff load failures from a provider quota showed a generic error
  it("recognizes a provider's API quota error", () => {
    expect(
      describePullRequestDiffError("GitHub API rate limit exceeded.", "GitHub", "pr").title,
    ).toBe("GitHub rate limit reached");
  });

  it("does not blame a rate limit for an unknown connection failure", () => {
    const result = describePullRequestDiffError(
      "Failed to fetch remote environment endpoint http://localhost:49477/api/pull-requests/diff (TypeError: Failed to fetch).",
      "GitHub",
      "pr",
    );

    expect(result.title).toBe("Couldn't load the changes");
    expect(result.description).toContain("Try again");
    expect(result.description).not.toContain("localhost");
    expect(result.description).not.toContain("limit");
  });

  it("localizes the explanation and preserves the host name", async () => {
    initializeGT({
      defaultLocale: "en",
      locales: ["en", "zh"],
      loadTranslations: async (locale) => (locale === "zh" ? zhTranslations : {}),
    });
    await getTranslationsSnapshot("zh");
    setActiveLocale("zh");
    try {
      expect(describePullRequestDiffError("rate limit exceeded", "Meituan Code", "pr", m)).toEqual({
        title: "Meituan Code 请求频率已达上限",
        description:
          "Meituan Code 暂时限制了请求，无法加载差异。请稍后重试，或在 Meituan Code 查看更改。",
      });
      expect(describePullRequestDiffError("Connection failed", "GitHub", "pr", m)).toEqual({
        title: "无法加载更改",
        description: "当前环境无法加载此合并请求的差异。请重试，或在 GitHub 查看更改。",
      });
    } finally {
      setActiveLocale("en");
    }
  });
});

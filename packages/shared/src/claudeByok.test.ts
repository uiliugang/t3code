import { describe, expect, it } from "vite-plus/test";
import {
  claudeByokModelError,
  claudeByokSelectionError,
  claudeByokUrlError,
  normalizeClaudeByokBaseUrl,
  readClaudeByokAuthMode,
  readClaudeByokProtocol,
  withClaudeByokVariable,
} from "./claudeByok.ts";

describe("Claude BYOK configuration", () => {
  it("keeps one credential and explicitly masks the inherited alternative", () => {
    expect(readClaudeByokProtocol([])).toBe("anthropic");
    expect(
      readClaudeByokProtocol(withClaudeByokVariable([], "T3_CLAUDE_API_FORMAT", "openai")),
    ).toBe("openai");
    const bearer = withClaudeByokVariable([], "ANTHROPIC_AUTH_TOKEN", "secret");
    expect(readClaudeByokAuthMode(bearer)).toBe("bearer");
    const apiKey = withClaudeByokVariable(bearer, "ANTHROPIC_API_KEY", "replacement");
    expect(readClaudeByokAuthMode(apiKey)).toBe("apiKey");
    expect(apiKey).toEqual([
      { name: "ANTHROPIC_API_KEY", value: "replacement", sensitive: true },
      { name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: true },
    ]);
    expect(
      readClaudeByokAuthMode([
        { name: "ANTHROPIC_API_KEY", value: "", sensitive: true, valueRedacted: true },
      ]),
    ).toBe("apiKey");
  });
  it("validates base URLs and preserves exact model IDs", () => {
    expect(normalizeClaudeByokBaseUrl("https://ba.test/prefix/v1/")).toBe("https://ba.test/prefix");
    for (const url of ["https://ba.test/prefix", "http://localhost:9001/v1/"])
      expect(claudeByokUrlError(url)).toBeNull();
    for (const url of [
      "",
      "file:///etc/hosts",
      "https://key@ba.test",
      "https://ba.test?token=key",
      "https://ba.test/v1/messages",
    ])
      expect(claudeByokUrlError(url)).not.toBeNull();
    const settings = { customModelsOnly: true, customModels: ["CaseSensitive"] };
    expect(claudeByokModelError(settings, "CaseSensitive")).toBeNull();
    expect(claudeByokModelError(settings, "casesensitive")).not.toBeNull();
    expect(claudeByokModelError({ ...settings, customModels: [] }, "sonnet")).not.toBeNull();
    expect(
      claudeByokSelectionError({ customModelsOnly: true, models: [] }, "sonnet"),
    ).not.toBeNull();
    expect(claudeByokSelectionError({ models: [] }, "sonnet")).toBeNull();
  });
});

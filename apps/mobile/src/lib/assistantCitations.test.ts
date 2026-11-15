import { EnvironmentId, MessageId, ThreadId, TurnItemId } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  parseAssistantCitationHref,
  formatAssistantCitationHref,
} from "@t3tools/shared/assistantCitations";
import {
  projectComposerContextForProvider,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";
import { mobileAssistantCitation, mobileResponseContext } from "./assistantCitations";

const source = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
};

describe("mobile assistant citations", () => {
  it("preserves the selected Chinese and emoji text through the shared citation format", () => {
    const text = "检查 😀\n  中文";
    const citation = mobileAssistantCitation(source, text, `开始 ${text} 结束`)!;
    expect(citation).toMatchObject({ ...source, text, prefix: "开始 ", suffix: " 结束" });
    expect(parseAssistantCitationHref(formatAssistantCitationHref(citation))).toEqual(citation);
    expect(serializeAssistantCitation(citation)).toContain("t3-citation:");
  });

  it("keeps repeated native selections without guessing which rendered occurrence was selected", () => {
    const citation = mobileAssistantCitation(source, "重复", "重复，重复")!;
    expect(citation).toMatchObject({ text: "重复", prefix: "", suffix: "" });
    expect(mobileAssistantCitation(source, "   ")).toBeNull();
    expect(mobileAssistantCitation(source, "字".repeat(8001))).toBeNull();
    expect(mobileAssistantCitation(source, "字".repeat(8000))).not.toBeNull();
  });

  it("bounds an entire long response and keeps its item identity for provider rereading", () => {
    const itemId = TurnItemId.make("item-1");
    const markdown = `**先检查** ${"字".repeat(293)}😀 ${"后续".repeat(5000)}`;
    const response = mobileResponseContext(source, itemId, markdown)!;
    expect(response.itemId).toBe(itemId);
    expect(response.citation.text).toMatch(/^先检查 /);
    expect(response.citation.text.length).toBeLessThanOrEqual(300);
    expect(response.citation.text).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(mobileResponseContext(source, itemId, " \n ")).toBeNull();
    const prompt = projectComposerContextForProvider({
      text: formatComposerContextReference(response),
      records: [response],
    });
    expect(prompt).toContain("item-1");
    expect(prompt).toContain("先检查");
    expect(prompt.length).toBeLessThan(2000);
  });
});

import {
  ASSISTANT_CITATION_CONTEXT_LENGTH,
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  type AssistantCitation,
  type MessageId,
  type ResponseContextRecord,
  type ScopedThreadRef,
  type TurnItemId,
} from "@t3tools/contracts";
import {
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";

type CitationSource = ScopedThreadRef & { readonly messageId: MessageId };

function boundedText(text: string, maxLength: number): string {
  const last = text.charCodeAt(maxLength - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? maxLength - 1 : maxLength);
}

export function mobileAssistantCitation(
  source: CitationSource,
  text: string,
  renderedText = "",
): AssistantCitation | null {
  if (!text.trim() || text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH) return null;
  const normalized = renderedText.replace(/\s+/gu, " ");
  const quote = text.replace(/\s+/gu, " ");
  const found = normalized.indexOf(quote);
  // Native selection offsets belong to a text block, not the whole response.
  const unique = found >= 0 && normalized.indexOf(quote, found + 1) < 0;
  const start = unique ? found : 0;
  const end = start + quote.length;
  const prefix = unique
    ? normalized.slice(Math.max(0, start - ASSISTANT_CITATION_CONTEXT_LENGTH), start)
    : "";
  return {
    version: 1,
    ...source,
    text,
    start,
    end,
    prefix: prefix.replace(/^[\uDC00-\uDFFF]/u, ""),
    suffix: unique ? boundedText(normalized.slice(end), ASSISTANT_CITATION_CONTEXT_LENGTH) : "",
  };
}

export function mobileResponseContext(
  source: CitationSource,
  itemId: TurnItemId,
  markdown: string,
): ResponseContextRecord | null {
  const rendered =
    searchableMessageSegments({ role: "assistant", text: markdown, streaming: false })
      ?.join(" ")
      .trim() ?? "";
  const text = boundedText(rendered, 300);
  const citation = mobileAssistantCitation(source, text, rendered);
  if (!citation) return null;
  return {
    version: 1,
    kind: "response",
    contextId: toKindScopedComposerContextId("response", source.messageId),
    label: sanitizeComposerContextLabel(boundedText(text, 64), "response"),
    citation,
    itemId,
  };
}

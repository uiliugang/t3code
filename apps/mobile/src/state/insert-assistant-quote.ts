import type { AssistantCitation, ResponseContextRecord } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import {
  getComposerDraftSnapshot,
  insertComposerDraftContext,
  insertComposerDraftText,
} from "./use-composer-drafts";

export async function insertAssistantQuote(input: {
  readonly draftKey: string;
  readonly quote: AssistantCitation | ResponseContextRecord;
  readonly flushPendingInput: () => Promise<void>;
  readonly signal: AbortSignal;
}): Promise<"inserted" | "full" | "cancelled"> {
  if (input.signal.aborted) return "cancelled";
  await input.flushPendingInput();
  if (input.signal.aborted) return "cancelled";
  const draft = getComposerDraftSnapshot(input.draftKey);
  const insertion = { text: draft.text, start: draft.text.length, end: draft.text.length };
  if ("kind" in input.quote) {
    return insertComposerDraftContext(
      input.draftKey,
      {
        text: formatComposerContextReference(input.quote),
        context: { version: 1, records: [input.quote] },
      },
      insertion,
    )
      ? "inserted"
      : "full";
  }
  const before = draft.text.length > 0 && !/\s$/u.test(draft.text) ? " " : "";
  insertComposerDraftText(
    input.draftKey,
    `${before}${serializeAssistantCitation(input.quote)} `,
    insertion,
  );
  return "inserted";
}

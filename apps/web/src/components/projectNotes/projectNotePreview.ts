import { wordsHast } from "~/markdown/wordsHast";

// Never put private notes into the shared conversation Markdown cache or resolver.
export function parseProjectNotePreview(markdown: string) {
  return wordsHast(markdown, {
    math: false,
    breaks: false,
    escapeHtml: true,
    insights: false,
    extensions: { inert: true },
  });
}

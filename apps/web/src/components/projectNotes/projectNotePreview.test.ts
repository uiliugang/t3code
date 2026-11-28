import { expect, it } from "vite-plus/test";
import { toHtml } from "hast-util-to-html";
import { parseProjectNotePreview } from "./projectNotePreview";

it("never renders active links, assets or raw HTML while preserving Markdown formatting", () => {
  const html = toHtml(
    parseProjectNotePreview(
      "# Plan\n\nRead [draft](../private.md), [file](file:///private.md), [external](https://example.invalid/), [unsafe](javascript:alert%281%29).\n\n![image label](https://example.invalid/asset)\n\n<iframe src=https://example.invalid/>",
    ),
  );
  expect(html).toContain("<h1");
  expect(html).toContain("Read draft, file, external, unsafe.");
  expect(html).toContain("image label");
  expect(html).not.toMatch(/<(?:a |img|iframe|script|video|object|embed|source|svg)/i);
  expect(html).not.toMatch(/\b(?:src|href|onerror)=/i);
});

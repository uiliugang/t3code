import { getTranslationsSnapshot, GTProvider } from "gt-react";
import { expect, it } from "vite-plus/test";

import { initializeI18n } from "~/i18n/initializeI18n";
import { render } from "../../../test/render";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";

it.each([
  { lineEnd: 7, label: "终端 2 第 7 行" },
  { lineEnd: 9, label: "终端 2 第 7–9 行" },
])("shows the exact Simplified Chinese line label $label", async ({ lineEnd, label }) => {
  initializeI18n(() => {});
  const translations = await getTranslationsSnapshot("zh");
  await using screen = await render(
    <GTProvider locale="zh" translations={translations}>
      <TerminalContextInlineChip
        terminalLabel="终端 2"
        lineStart={7}
        lineEnd={lineEnd}
        text="terminal output"
        detailsMode="popover"
      />
    </GTProvider>,
  );

  await expect.element(screen.getByText(label, { exact: true })).toBeVisible();
});

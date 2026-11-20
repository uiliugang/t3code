import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Group names keep IME confirmation separate from submission",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("alpha");
    await t3.project("beta");
    await t3.open();
    await browser.locator("[data-draft-project-trigger]").tap();
    await screen.getByRole("option", /alpha/).tap();
    await browser.locator("[data-draft-project-trigger]").tap();
    const beta = screen.getByRole("checkbox", /^(Combine with beta|与 beta 组合)$/);
    await beta.tap();
    const name = screen.getByRole("textbox", /^(Group name|分组名称)$/);
    await name.fill("Client and API");
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      const prevented = await browser.evaluate((shape) => {
        const input = document.querySelector('[aria-label="Group name"], [aria-label="分组名称"]');
        if (!input) throw new Error("Group name input did not render");
        const event = new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
          ...shape,
        });
        input.dispatchEvent(event);
        return event.defaultPrevented;
      }, composition);
      await app.screenshot("group-name-composition");
      expect(prevented).toBe(false);
      await expect(name).toBeVisible();
    }
    await name.press("Escape");
    await expect(name).not.toBeVisible();
    await browser.locator("[data-draft-project-trigger]").tap();
    await expect(beta).not.toBeChecked();
  },
);

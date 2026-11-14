import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "worktree dependency sharing defaults on and persists an opt-out",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("shared-dependencies");
    await t3.open("/settings/worktrees");
    const toggle = screen.getByRole("switch", /Shared dependencies|共享依赖/);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await app.screenshot("shared-dependencies-on");
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await t3.open("/settings/worktrees");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await browser.locator("#worktree-creation").scrollIntoView();
    await app.screenshot("shared-dependencies-off");
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  },
);

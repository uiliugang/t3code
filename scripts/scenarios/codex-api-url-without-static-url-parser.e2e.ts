/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Codex API settings stay usable when URL.parse is unavailable",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("url-compatibility");
    await t3.open("/settings/providers");
    await screen
      .getByRole("button", /^(Add provider|添加提供商)$/)
      .first()
      .tap();
    await screen.getByRole("button", /^(Next|下一步)$/).tap();
    await screen.getByRole("button", /^(Add instance|添加实例)$/).tap();
    await screen.getByRole("combobox", /^(Connection mode|连接方式)$/).tap();
    await screen.getByRole("option", /^(API key|API 密钥)$/).tap();
    await browser.evaluate(() => {
      Reflect.deleteProperty(URL, "parse");
      return null;
    });

    const baseUrl = screen.getByRole("textbox", /^(API base URL|API 基础 URL)$/);
    await baseUrl.fill("https://audit.invalid/v1");
    await app.screenshot("codex-api-url");
    await expect(baseUrl).toBeVisible();
  },
);

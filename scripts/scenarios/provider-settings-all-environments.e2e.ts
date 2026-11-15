import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import { runPromise, test, WEB } from "./t3.ts";

test(
  "Provider settings distinguish checking all environments from checking one environment",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("provider-settings");
    await t3.open("/settings/providers");
    const local = await runPromise(
      HttpClient.get(`${app.baseUrl}/.well-known/t3/environment`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Struct({ label: Schema.String }))),
        Effect.provide(FetchHttpClient.layer),
      ),
    );
    const environment = screen.getByRole("button", /^(Environment scope|环境范围):/);
    await expect(environment).toHaveText(local.label);
    await environment.tap();
    await app.screenshot("provider-environment-menu");
    const all = screen.getByRole("menuitemradio", /^(All environments|所有环境)$/);
    await expect(all).toBeVisible();
    await all.tap();
    const checkAll = screen.getByRole("button", /^(Check all environments|检查全部环境)$/);
    await expect(checkAll).toBeEnabled();
    await app.screenshot("all-environment-actions");
    await checkAll.tap();
    await expect(checkAll).toBeEnabled();

    await environment.tap();
    await screen.getByRole("menuitemradio", local.label).tap();
    await expect(environment).toHaveText(local.label);
    await expect(checkAll).not.toBeVisible();
    await expect(
      screen.getByRole("button", /^(Refresh provider status|刷新提供商状态)/),
    ).toBeEnabled();
    await app.screenshot("single-environment-actions");
  },
);

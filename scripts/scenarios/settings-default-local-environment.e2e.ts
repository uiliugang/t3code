import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import { runPromise, test, WEB } from "./t3.ts";

test(
  "Settings default to the local environment and retain an explicit all-environments selection",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("settings-demo");
    await t3.open("/settings/communication");

    const local = await runPromise(
      HttpClient.get(`${app.baseUrl}/.well-known/t3/environment`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Struct({ label: Schema.String }))),
        Effect.provide(FetchHttpClient.layer),
      ),
    );
    const environment = screen.getByRole("button", /^(Environment scope|环境范围):/);
    await expect(environment).toBeVisible();
    await app.screenshot("default-environment");
    await expect(environment).toHaveText(local.label);

    await environment.tap();
    await screen.getByRole("menuitemradio", /^(All environments|所有环境)$/).tap();
    await expect(environment).toHaveText(/^(All environments|所有环境)$/);
    await screen.getByRole("button", /^(Voice|语音)$/).tap();
    await expect(screen.getByRole("heading", /^(Voice input|语音输入)$/)).toBeVisible();
    await expect(environment).toHaveText(/^(All environments|所有环境)$/);
    await app.screenshot("explicit-all-environments");

    await screen.getByRole("button", /^(Skills|技能管理)$/).tap();
    await expect(screen.getByRole("heading", local.label)).toBeVisible();
    await expect(environment).toHaveText(local.label);
    await screen.getByRole("button", /^(Communication|通讯)$/).tap();
    await expect(screen.getByRole("heading", /^(Communication|通讯)$/)).toBeVisible();
    await expect(environment).toHaveText(/^(All environments|所有环境)$/);
    await environment.tap();
    await screen.getByRole("menuitemradio", local.label).tap();
    await expect(environment).toHaveText(local.label);
  },
);

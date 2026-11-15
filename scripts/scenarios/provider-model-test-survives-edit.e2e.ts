/// <reference lib="dom" />
// @effect-diagnostics-next-line nodeBuiltinImport:off -- HTTP fixture deliberately holds responses open until cancellation.
import * as NodeHttp from "node:http";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

const SettingsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettings = Schema.decodeEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);

test(
  "A running model test can still be cancelled after editing another model",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const service = NodeHttp.createServer((request, response) => {
      if (request.url?.startsWith("/v1/models")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "Slow" }, { id: "Other" }] }));
      } else if (request.url !== "/v1/responses") {
        response.writeHead(404).end();
      }
      // Keep inference pending until the client cancels it.
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    const address = service.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture port");
    const port = address.port;
    const restore = await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = (yield* Path.Path).join(T3_HOME, "userdata/settings.json");
        const original = yield* fs.readFileString(file);
        const settings = yield* decodeSettings(original);
        yield* fs.writeFileString(
          file,
          yield* encodeSettings({
            ...settings,
            providerInstances: {
              ...(settings.providerInstances as Record<string, unknown>),
              codex_check: {
                driver: "codex",
                enabled: true,
                config: {
                  connectionMode: "byok",
                  setupMode: "existing",
                  runtimeSource: "local",
                  customModels: ["Slow", "Other"],
                },
                environment: [
                  {
                    name: "T3_CODEX_BASE_URL",
                    value: `http://127.0.0.1:${port}/v1`,
                    sensitive: false,
                  },
                  { name: "T3_CODEX_API_KEY", value: "scenario-fixture", sensitive: true },
                ],
              },
            },
          }),
        );
        return fs.writeFileString(file, original);
      }),
    );
    try {
      await t3.project("model-test");
      await t3.open("/settings/providers?instanceId=codex_check");
      await screen.getByRole("button", "测试模型和工具：Slow", { exact: true }).tap();
      await expect(screen.getByRole("button", "取消模型测试：Slow", { exact: true })).toBeVisible();
      await screen.getByRole("button", "Edit Other", { exact: true }).tap();
      await screen.getByRole("textbox", "显示名称", { exact: true }).fill("Renamed Other");
      await browser.evaluate(() => {
        const group = document.querySelector('[data-model-slug="Other"]')!.parentElement!;
        [...group.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "保存")!
          .click();
        return null;
      });
      await expect(screen.getByText("Renamed Other", { exact: true })).toBeVisible();
      await app.screenshot("test-after-model-edit");
      await expect(screen.getByRole("button", "取消模型测试：Slow", { exact: true })).toBeVisible();
      await screen.getByRole("button", "取消模型测试：Slow", { exact: true }).tap();
      await expect(
        screen.getByRole("button", "测试模型和工具：Other", { exact: true }),
      ).toBeEnabled();
    } finally {
      service.closeAllConnections();
      service.close();
      await runPromise(restore);
    }
  },
);

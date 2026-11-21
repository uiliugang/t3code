import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

const decodeSettings = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      backgroundActivity: Schema.optionalKey(
        Schema.Struct({
          overrides: Schema.Struct({
            automaticGitFetchInterval: Schema.optionalKey(Schema.Number),
          }),
        }),
      ),
    }),
  ),
);

test(
  "Background intervals save without reporting an unsupported setting",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("background-settings");
    await t3.open("/settings/maintenance");
    await screen.getByLabel(/^(Background activity profile|后台活动模式)$/).tap();
    await screen.getByRole("option", /^(Advanced|高级)$/).tap();
    const interval = screen.getByLabel(/^(Git fetch interval in seconds|Git 获取间隔（秒）)$/);
    await interval.fill("65");
    await browser.keyboard.press("Tab");
    await expect
      .poll(() =>
        runPromise(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const contents = yield* fs.readFileString(`${T3_HOME}/userdata/settings.json`);
            return decodeSettings(contents).backgroundActivity?.overrides.automaticGitFetchInterval;
          }),
        ),
      )
      .toBe(65_000);
    // The file write precedes the RPC reply and the client's save validation.
    await browser.evaluate(`async () => {
      const { appAtomRegistry } = await import('/src/rpc/atomRegistry.ts');
      const { pendingScopedWritesAtom } = await import('/src/components/settings/scopedSettings.ts');
      const settled = () => appAtomRegistry.get(pendingScopedWritesAtom)
        .every(write => write.settledOver !== undefined);
      if (settled()) return true;
      return new Promise(resolve => {
        const unsubscribe = appAtomRegistry.subscribe(pendingScopedWritesAtom, () => {
          if (!settled()) return;
          unsubscribe();
          resolve(true);
        });
      });
    }`);
    await app.screenshot("background-activity-save");
    expect(
      await screen
        .getByText(/This environment does not support this setting|此环境不支持该设置/)
        .count(),
    ).toBe(0);
    await expect(interval).toHaveValue("65");
  },
);

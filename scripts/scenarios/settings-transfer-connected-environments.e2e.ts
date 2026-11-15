import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { expect } from "e2e";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { APP_DIR, T3_HOME } from "../e2e.config.ts";
import { prepareHome, start } from "./start-app.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const REMOTE_HOME = `${T3_HOME}-transfer-remote`;
const REMOTE_LABEL = "Transfer remote";
const IMPORT_MARKER = "Settings transfer reached the remote environment";
const decodeSettings = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeSettings = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const remoteServer = Effect.fn("scenario.transferRemote")(function* (
  devUrl: string,
  paired: (target: { host: string; token: string }) => void,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const node = yield* HostProcess.ExecutablePath;
  const env = yield* HostProcess.Environment;
  const port = yield* (yield* NetService.NetService).reserveLoopbackPort();
  yield* prepareHome(REMOTE_HOME);
  const settingsPath = path.join(REMOTE_HOME, "userdata/settings.json");
  const settings = yield* decodeSettings(yield* fs.readFileString(settingsPath));
  yield* fs.writeFileString(
    settingsPath,
    yield* encodeSettings({
      ...settings,
      environmentName: REMOTE_LABEL,
    }),
  );
  const token = yield* Deferred.make<string>();
  yield* start({
    cwd: APP_DIR,
    command: node,
    args: [
      "apps/server/src/bin.ts",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      REMOTE_HOME,
      "--dev-url",
      devUrl,
    ],
    env: {
      PATH: `${path.join(REMOTE_HOME, "bin")}:${env.PATH ?? ""}`,
      HOME: env.HOME,
      T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
    },
    onLine: (line) => {
      const value = /^Token:\s*(\S+)/.exec(line)?.[1];
      return value === undefined ? Effect.void : Deferred.succeed(token, value).pipe(Effect.asVoid);
    },
  });
  paired({ host: `http://127.0.0.1:${port}`, token: yield* Deferred.await(token) });
  return yield* Effect.never;
});

test(
  "Settings transfer selects a connected remote environment while settings default to local",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("local-transfer-project");
    const pairing = Promise.withResolvers<{ host: string; token: string }>();
    const server = Effect.runFork(
      remoteServer(app.baseUrl ?? "", pairing.resolve).pipe(
        Effect.scoped,
        Effect.provide([NodeServices.layer, NetService.layer]),
      ),
    );
    server.addObserver(() => pairing.reject(new Error("The remote fixture server stopped.")));
    try {
      const { host, token } = await pairing.promise;
      await makeState(REMOTE_HOME).state.project("remote-transfer-project");
      await t3.open("/settings/connections");
      await screen.getByRole("button", /^(Add environment|添加环境)$/).tap();
      const dialog = screen.getByRole("dialog").last();
      await dialog.getByPlaceholder("backend.example.com").fill(host);
      await dialog.getByPlaceholder("PAIRCODE").fill(token);
      await dialog.getByRole("button", /^(Add environment|添加环境)$/).tap();
      await expect(screen.getByText(/(Connected|已连接)/, { exact: false }).first()).toBeVisible();

      await app.open("/settings/general#settings-import-export");
      const environment = screen.getByRole("button", /^(Environment scope|环境范围):/);
      await app.screenshot("transfer-environment-selector");
      await expect(environment).toBeVisible();
      await expect(environment).not.toHaveText(REMOTE_LABEL);
      await environment.tap();
      await screen.getByRole("menuitemradio", new RegExp(`^${REMOTE_LABEL}`)).tap();
      await expect(environment).toHaveText(REMOTE_LABEL);

      const download = await browser.waitForDownload(() =>
        screen.getByRole("button", /^(Export|导出)$/).tap(),
      );
      const contents = await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(download.absolutePath)),
      );
      expect(contents).toContain("remote-transfer-project");
      expect(contents).not.toContain("local-transfer-project");
      const file = JSON.parse(contents);
      const importPath = `${REMOTE_HOME}/import.json`;
      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.writeFileString(
            importPath,
            JSON.stringify({
              ...file,
              server: { ...file.server, threadTitleInstructions: IMPORT_MARKER },
            }),
          ),
        ),
      );
      await browser.locator('#settings-import-export input[type="file"]').setInputFiles(importPath);
      await expect(
        screen.getByRole(
          "heading",
          new RegExp(`(Import settings into|将设置导入).*${REMOTE_LABEL}`),
        ),
      ).toBeVisible();
      await screen.getByRole("button", /^(Import settings|导入设置)$/).tap();
      await expect(screen.getByRole("heading", /^(Settings imported|设置已导入)$/)).toBeVisible();
      const savedSettings = (home: string) =>
        runPromise(
          Effect.flatMap(FileSystem.FileSystem, (fs) =>
            fs.readFileString(`${home}/userdata/settings.json`),
          ),
        );
      expect(await savedSettings(REMOTE_HOME)).toContain(IMPORT_MARKER);
      expect(await savedSettings(T3_HOME)).not.toContain(IMPORT_MARKER);
      await app.screenshot("remote-settings-imported");
    } finally {
      await Effect.runPromise(Fiber.interrupt(server));
    }
  },
);

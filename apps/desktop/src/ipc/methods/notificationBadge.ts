import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_NOTIFICATION_BADGE_CHANNEL } from "../channels.ts";

const NotificationBadge = Schema.Struct({
  count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_147_483_647 })),
});

function applyNotificationBadge(
  platform: NodeJS.Platform,
  { count }: typeof NotificationBadge.Type,
): void {
  try {
    if (Electron.BrowserWindow.getFocusedWindow()) count = 0;
    if (platform === "darwin" || platform === "linux") {
      Electron.app.setBadgeCount(count);
    }
  } catch (error) {
    Effect.runSync(Effect.logWarning("Could not update notification badge", error));
  }
}

export const installNotificationBadge = Effect.fn("desktop.ipc.installNotificationBadge")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    const app = yield* ElectronApp.ElectronApp;
    const platform = yield* HostProcess.Platform;
    const clear = () => {
      applyNotificationBadge(platform, { count: 0 });
      for (const window of Electron.BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(SET_NOTIFICATION_BADGE_CHANNEL);
      }
    };
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: SET_NOTIFICATION_BADGE_CHANNEL,
        payload: NotificationBadge,
        result: Schema.Void,
        handler: (badge) =>
          Effect.sync(() => {
            if (badge.count > 0 && Electron.BrowserWindow.getFocusedWindow()) clear();
            else applyNotificationBadge(platform, badge);
          }),
      }),
    );
    yield* app.on("browser-window-focus", clear);
    yield* app.on("before-quit", clear);
    yield* Effect.addFinalizer(() => Effect.sync(clear));
  },
);

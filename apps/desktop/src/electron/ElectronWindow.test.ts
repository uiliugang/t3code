import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

const { appFocusMock, browserWindowMock, getAllWindowsMock, getFocusedWindowMock } = vi.hoisted(
  () => ({
    appFocusMock: vi.fn(),
    browserWindowMock: vi.fn(function BrowserWindowMock() {}),
    getAllWindowsMock: vi.fn(),
    getFocusedWindowMock: vi.fn(),
  }),
);

vi.mock("electron", () => ({
  app: {
    focus: appFocusMock,
  },
  BrowserWindow: Object.assign(browserWindowMock, {
    getAllWindows: getAllWindowsMock,
    getFocusedWindow: getFocusedWindowMock,
  }),
}));

import * as ElectronWindow from "./ElectronWindow.ts";

const layerTestFor = (platform: NodeJS.Platform) =>
  ElectronWindow.layer.pipe(Layer.provide(Layer.succeed(HostProcess.Platform, platform)));

const layerTest = layerTestFor("linux");

describe("ElectronWindow", () => {
  beforeEach(() => {
    appFocusMock.mockReset();
    browserWindowMock.mockReset();
    getAllWindowsMock.mockReset();
    getFocusedWindowMock.mockReset();
  });

  it.effect("reports which windows were created with a title bar overlay", () =>
    Effect.gen(function* () {
      const framed = { isDestroyed: () => false };
      const overlay = { isDestroyed: () => false };
      browserWindowMock
        .mockImplementationOnce(function FramedWindowMock() {
          return framed;
        })
        .mockImplementationOnce(function OverlayWindowMock() {
          return overlay;
        });
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* electronWindow.create({});
      yield* electronWindow.create({
        titleBarStyle: "hidden",
        titleBarOverlay: { color: "#01000000", height: 40 },
      });
      getAllWindowsMock.mockReturnValue([framed, overlay, { isDestroyed: () => false }]);

      const seen: Array<boolean> = [];
      yield* electronWindow.syncAllAppearance((_window, { titleBarOverlay }) =>
        Effect.sync(() => seen.push(titleBarOverlay)),
      );

      assert.deepEqual(seen, [false, true, false]);
    }).pipe(Effect.provide(layerTestFor("linux"))),
  );

  it.effect("preserves destroy failures and continues with later windows", () =>
    Effect.gen(function* () {
      const cause = new Error("window destroy failed");
      const window = {
        id: 43,
        destroy: vi.fn(() => {
          throw cause;
        }),
      } as unknown as Electron.BrowserWindow;
      const laterWindow = {
        id: 44,
        destroy: vi.fn(),
      } as unknown as Electron.BrowserWindow;
      getAllWindowsMock.mockReturnValueOnce([window, laterWindow]);

      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const exit = yield* Effect.exit(electronWindow.destroyAll);

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronWindow.ElectronWindowOperationError);
        assert.equal(error.operation, "destroy-window");
        assert.equal(error.windowId, 43);
        assert.isNull(error.channel);
        assert.strictEqual(error.cause, cause);
      }
      assert.equal(vi.mocked(laterWindow.destroy).mock.calls.length, 1);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("never falls back to an auxiliary window as the main window", () =>
    Effect.gen(function* () {
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const auxiliary = yield* electronWindow.create({}, { auxiliary: true });
      const ordinary = { isDestroyed: () => false } as unknown as Electron.BrowserWindow;
      Object.assign(auxiliary, { isDestroyed: () => false });

      getAllWindowsMock.mockReturnValue([auxiliary]);
      assert.isTrue((yield* electronWindow.currentMainOrFirst)._tag === "None");

      getAllWindowsMock.mockReturnValue([auxiliary, ordinary]);
      const current = yield* electronWindow.currentMainOrFirst;
      assert.isTrue(current._tag === "Some" && current.value === ordinary);
    }).pipe(Effect.provide(layerTest)),
  );
});

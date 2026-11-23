import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import { DesktopBackendPool } from "../../backend/DesktopBackendPool.ts";
import {
  PRIMARY_INSTANCE_ID,
  type DesktopBackendInstance,
} from "../../backend/DesktopBackendManager.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { CALL_PROJECT_NOTES_CHANNEL } from "../channels.ts";
import { callProjectNotes } from "./projectNotes.ts";

it.effect("only the trusted top frame can use the primary native Notes environment", () =>
  Effect.gen(function* () {
    const mainFrame = {};
    const nativeId = EnvironmentId.make("native");
    const calls = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    const ipc = yield* DesktopIpc.DesktopIpc.pipe(
      Effect.provide(
        DesktopIpc.layer({
          removeHandler: (channel) => void calls.delete(channel),
          handle: (channel, listener) => void calls.set(channel, listener),
          removeAllListeners: () => {},
          on: () => {},
        }).pipe(
          Layer.provide(
            Layer.mock(ElectronWindow.ElectronWindow, {
              main: Effect.succeedSome({
                webContents: { id: 1, mainFrame },
              } as unknown as Electron.BrowserWindow),
            }),
          ),
        ),
      ),
    );
    const count = yield* Ref.make(0);
    const instance: DesktopBackendInstance = {
      id: PRIMARY_INSTANCE_ID,
      label: Effect.succeed("Primary"),
      start: Effect.void,
      stop: () => Effect.void,
      currentConfig: Effect.succeedNone,
      snapshot: Effect.succeed({
        ready: true,
        desiredRunning: true,
        activePid: Option.none(),
        restartAttempt: 0,
        restartScheduled: false,
      }),
      waitForReady: () => Effect.succeed(true),
      projectNotesEnvironmentId: Effect.succeed(nativeId),
      callProjectNotes: () =>
        Ref.update(count, (n) => n + 1).pipe(
          Effect.as({
            ok: true,
            result: { _tag: "list", value: { notes: [], nextCursor: null } },
          } as const),
        ),
    };
    const instances = yield* Ref.make<ReadonlyArray<DesktopBackendInstance>>([instance]);
    yield* ipc
      .handle(callProjectNotes)
      .pipe(Effect.provide(Layer.mock(DesktopBackendPool, { list: Ref.get(instances) })));
    const app = { sender: { id: 1 }, senderFrame: mainFrame };
    const frame = { sender: { id: 1 }, senderFrame: {} };
    const guest = { sender: { id: 2 }, senderFrame: {} };
    const payload = {
      environmentId: nativeId,
      call: {
        _tag: "list",
        input: { projectId: ProjectId.make("fixture"), archived: false, limit: 1 },
      },
    };
    const invoke = (sender: typeof app, input: unknown) =>
      Effect.promise(() =>
        Promise.resolve(calls.get(CALL_PROJECT_NOTES_CHANNEL)!(sender, input)).catch(
          () => "rejected",
        ),
      );
    const denied = { ok: false, failure: { reason: "unavailable" } };
    assert.equal(yield* invoke(frame, payload), "rejected");
    assert.equal(yield* invoke(guest, payload), "rejected");
    assert.deepEqual(
      yield* invoke(app, { ...payload, environmentId: EnvironmentId.make("remote") }),
      denied,
    );
    assert.deepEqual(
      yield* invoke(app, { ...payload, ownerKey: "cannot-supply-owner", markdown: "private" }),
      denied,
    );
    assert.deepEqual(yield* invoke(app, payload), {
      ok: true,
      result: { _tag: "list", value: { notes: [], nextCursor: null } },
    });
    yield* Ref.set(instances, []);
    assert.deepEqual(yield* invoke(app, payload), denied);
    assert.equal(yield* Ref.get(count), 1);
  }),
);

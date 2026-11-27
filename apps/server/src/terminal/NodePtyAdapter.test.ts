import * as NodeEvents from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

function makeNativeProcess(pid = 42) {
  const events = new NodeEvents.EventEmitter();
  return {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((callback: (data: string) => void) => {
      events.on("data", callback);
      return {
        dispose: () => {
          events.off("data", callback);
        },
      };
    }),
    onExit: vi.fn((callback: (event: { exitCode: number; signal?: number }) => void) => {
      events.on("exit", callback);
      return {
        dispose: () => {
          events.off("exit", callback);
        },
      };
    }),
    events,
  };
}

const spawn = vi.fn(() => makeNativeProcess());

const spawnInput = { shell: "/bin/sh", cwd: ".", cols: 80, rows: 24, env: {} };

const fakeNodePty = { spawn } as unknown as typeof import("node-pty");

const layerTest = NodePtyAdapter.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(HostProcess.Platform, "linux"),
      Layer.succeed(HostProcess.Architecture, "x64"),
      Layer.succeed(NodePtyAdapter.NodePtyModuleLoaderRef, () => Promise.resolve(fakeNodePty)),
    ),
  ),
);

it.effect("retries the spawn-helper repair after a stalled check times out", () =>
  Effect.gen(function* () {
    let stalled = true;
    const chmod = vi.fn();
    const fileSystem = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) => ({
        ...fs,
        exists: () => (stalled ? Effect.never : Effect.succeed(true)),
        chmod: (path: string) => Effect.sync(() => chmod(path)),
      })),
    ).pipe(Layer.provide(NodeServices.layer));
    const adapter = yield* PtyAdapter.PtyAdapter.pipe(
      Effect.provide(
        NodePtyAdapter.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              fileSystem,
              Layer.succeed(HostProcess.Platform, "linux"),
              Layer.succeed(HostProcess.Architecture, "x64"),
              Layer.succeed(NodePtyAdapter.NodePtyModuleLoaderRef, () =>
                Promise.resolve(fakeNodePty),
              ),
            ),
          ),
        ),
      ),
    );
    const input = { ...spawnInput, shell: "/bin/sh" };

    const first = yield* adapter.spawn(input).pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.join(first);
    assert.strictEqual(chmod.mock.calls.length, 0);

    stalled = false;
    yield* adapter.spawn(input);
    assert.strictEqual(chmod.mock.calls.length, 1);
  }),
);

it.effect("forwards POSIX PTY signals and preserves ordered output", () =>
  Effect.gen(function* () {
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn(spawnInput);
    const nativeProcess = spawn.mock.results.at(-1)!.value;
    const output: string[] = [];
    const stop = process.onData((data) => output.push(data));
    nativeProcess.events.emit("data", "first");
    process.kill("SIGTERM");
    nativeProcess.events.emit("data", "last");
    stop();
    nativeProcess.events.emit("data", "unsubscribed");
    assert.deepEqual(output, ["first", "last"]);
    assert.deepEqual(nativeProcess.kill.mock.calls, [["SIGTERM"]]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("replays an exit to late subscribers and respects unsubscription", () =>
  Effect.gen(function* () {
    const adapter = yield* PtyAdapter.PtyAdapter;
    const process = yield* adapter.spawn(spawnInput);
    const nativeProcess = spawn.mock.results.at(-1)!.value;
    const removed = vi.fn();
    process.onExit(removed)();
    nativeProcess.events.emit("exit", { exitCode: 7, signal: 2 });
    const late = vi.fn();
    process.onExit(late);
    nativeProcess.events.emit("exit", { exitCode: 9 });
    assert.equal(removed.mock.calls.length, 0);
    assert.deepEqual(late.mock.calls, [[{ exitCode: 7, signal: 2 }]]);
    assert.equal(nativeProcess.events.listenerCount("exit"), 0);
  }).pipe(Effect.provide(layerTest)),
);

// @effect-diagnostics nodeBuiltinImport:off - Exercises Node pipe backpressure and closure.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeReadline from "node:readline";
import * as NodeStream from "node:stream";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";

const openSocket = vi.hoisted(() => vi.fn());
vi.mock("node:net", () => ({ Socket: openSocket }));

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "desktop-browser-channel-",
}).pipe(Layer.provide(NodeServices.layer));

function desktopPipes(config: ServerConfig.ServerConfig["Service"], brokenFd?: number) {
  const input = new NodeStream.PassThrough();
  const [control, peer] = NodeStream.duplexPair({ highWaterMark: 1024 });
  openSocket.mockImplementation(function ({ fd, writable }: { fd: number; writable: boolean }) {
    if (fd === brokenFd) throw new Error("invalid descriptor");
    return writable ? control : input;
  });
  return {
    control,
    peer,
    input,
    send: (event: object) => Effect.sync(() => input.write(`${JSON.stringify(event)}\n`)),
    layer: DesktopBrowserChannel.layer.pipe(
      Layer.provide(
        ServerConfig.layer({
          ...config,
          desktopBrowserFd: 41,
          desktopBrowserControlFd: 42,
        }),
      ),
    ),
  };
}

it.effect.each([41, 42])("keeps the server usable when desktop pipe %d cannot open", (fd) =>
  Effect.gen(function* () {
    const { layer, input, control } = desktopPipes(yield* ServerConfig.ServerConfig, fd);
    yield* Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
      expect(channel.available).toBe(false);
      expect((fd === 41 ? control : input).destroyed).toBe(true);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(configLayer)),
);

it.effect("protects unknown desktop visibility until an explicit hidden report arrives", () =>
  Effect.gen(function* () {
    const { send, layer } = desktopPipes(yield* ServerConfig.ServerConfig);
    yield* Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
      const key = { threadId: "thread-1", tabId: "tab-1" };

      expect(channel.isShown(key)).toBe(true);
      yield* send({ type: "attached", ...key });
      yield* channel.awaitAttached(key, "5 seconds");
      expect(channel.isShown(key)).toBe(true);

      yield* send({ type: "shown", ...key, shown: false });
      yield* send({ type: "attached", threadId: key.threadId, tabId: "sentinel-1" });
      yield* channel.awaitAttached({ threadId: key.threadId, tabId: "sentinel-1" }, "5 seconds");
      expect(channel.isShown(key)).toBe(false);

      const shown = yield* channel.awaitShown(key, "5 seconds").pipe(Effect.forkChild);
      yield* send({ type: "shown", ...key, shown: true });
      expect(yield* Fiber.join(shown)).toBe(true);
      expect(channel.isShown(key)).toBe(true);

      yield* send({ type: "shown", ...key, shown: false });
      yield* send({ type: "humanInput", ...key });
      yield* send({ type: "detached", ...key });
      yield* send({ type: "attached", threadId: key.threadId, tabId: "sentinel-3" });
      yield* channel.awaitAttached({ threadId: key.threadId, tabId: "sentinel-3" }, "5 seconds");
      expect(channel.isShown(key)).toBe(true);
      expect(channel.hasHumanInput(key)).toBe(true);
      channel.clearHumanInput(key);
      expect(channel.hasHumanInput(key)).toBe(false);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(configLayer)),
);

it.live.each([
  "tab detaches",
  "control write fails",
  "control peer closes",
  "event pipe ends",
] as const)("closes the relay when the %s", (reason) =>
  Effect.gen(function* () {
    const { control, peer, input, send, layer } = desktopPipes(yield* ServerConfig.ServerConfig);
    yield* Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
      const key = { threadId: "thread-1", tabId: "tab-1" };

      yield* send({ type: "attached", ...key });
      yield* channel.awaitAttached(key, "5 seconds");
      const url = yield* channel.endpoint(key);
      const socket = new WebSocket(url);
      yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));
      const closed = new Promise<void>((resolve) =>
        socket.addEventListener("close", () => resolve()),
      );
      yield* Effect.promise(
        () => new Promise<void>((resolve) => socket.addEventListener("open", () => resolve())),
      );

      const next = JSON.stringify({ id: 2, method: "Page.getFrameTree" });
      const waitForWrite = () => new Promise<void>((resolve) => peer.once("readable", resolve));
      const hidden = { ...key, tabId: "hidden" };
      yield* send({ type: "shown", ...hidden, shown: false });
      yield* send({ type: "attached", ...hidden });
      expect(yield* channel.awaitAttached(hidden, "5 seconds")).toBe(true);
      const waitingForAttach = yield* channel
        .awaitAttached({ ...key, tabId: "new" }, Infinity)
        .pipe(Effect.forkChild({ startImmediately: true }));
      const waitingForShow = yield* channel
        .awaitShown(hidden, Infinity)
        .pipe(Effect.forkChild({ startImmediately: true }));
      if (reason === "event pipe ends") {
        input.end();
      } else if (reason === "control write fails" || reason === "control peer closes") {
        const writing = waitForWrite();
        socket.send(next);
        yield* Effect.promise(() => writing);
        if (reason === "control peer closes") peer.end();
        else control.destroy(new Error("broken desktop pipe"));
      } else {
        const large = JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression: "x".repeat(360_000) },
        });
        const backpressured = waitForWrite();
        socket.send(large);
        yield* Effect.promise(() => backpressured).pipe(Effect.timeout("2 seconds"));
        const pendingBytes = control.writableLength;
        expect(pendingBytes).toBeGreaterThan(0);
        const second = yield* channel
          .turn(key.threadId, true)
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect(control.writableLength).toBe(pendingBytes);
        const lines = NodeReadline.createInterface({ input: peer });
        yield* Effect.addFinalizer(() => Effect.sync(() => lines.close()));
        const reader = lines[Symbol.asyncIterator]();
        for (const expected of [
          { type: "cdp", ...key, message: large },
          { type: "turn", threadId: key.threadId, active: true },
        ]) {
          const line = yield* Effect.promise(() => reader.next()).pipe(Effect.timeout("2 seconds"));
          if (line.done)
            throw new Error("Desktop control pipe ended before both commands arrived.");
          expect(JSON.parse(line.value)).toEqual(expected);
        }
        yield* Fiber.join(second);
        yield* send({ type: "detached", ...key });
      }
      yield* Effect.promise(() => closed).pipe(Effect.timeout("2 seconds"));
      if (reason === "tab detaches") {
        expect(channel.available).toBe(true);
        expect(yield* channel.isAttached(hidden)).toBe(true);
      } else {
        expect(channel.available).toBe(false);
        expect(yield* Fiber.join(waitingForAttach)).toBe(false);
        expect(yield* Fiber.join(waitingForShow)).toBe(false);
        expect(yield* channel.isAttached(hidden)).toBe(false);
      }
    }).pipe(Effect.scoped, Effect.provide(layer));
  }).pipe(Effect.provide(configLayer)),
);

import { it, expect } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { createNoiseMediaListener } from "./NoiseMediaListener.ts";

it.live(
  "streams admitted HTTP and WebSocket requests from Chromium to their encrypted channels",
  () =>
    Effect.gen(function* () {
      const origin = "t3://app";
      const bridge = yield* Effect.acquireRelease(
        Effect.promise(() => createNoiseMediaListener(origin)),
        (listener) => Effect.sync(() => listener.release()),
      );
      const path = "/api/device-hub/example";
      const get = (url: string, origin?: string) =>
        HttpClient.get(url, origin ? { headers: { origin } } : {}).pipe(
          Effect.flatMap((response) =>
            response.text.pipe(Effect.map((text) => ({ headers: response.headers, text }))),
          ),
        );
      expect((yield* get(bridge.origins.asset + path).pipe(Effect.result))._tag).toBe("Failure");
      expect(
        (yield* get(bridge.origins.device + path, "https://elsewhere.invalid").pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      const result = yield* Effect.forkChild(get(bridge.origins.device + path, origin));
      const channel = yield* Effect.promise(() => bridge.accept());
      const prefix = yield* Effect.promise(() => bridge.read(channel));
      expect(new TextDecoder().decode(prefix)).toContain("GET " + path + " HTTP/1.1");
      yield* Effect.promise(async () => {
        await bridge.write(
          channel,
          Buffer.from("HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\n"),
        );
        await bridge.write(
          channel,
          Buffer.from("Content-Length: 4\r\nConnection: close\r\n\r\ndata"),
        );
      });
      const response = yield* Fiber.join(result);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.text).toBe("data");
      bridge.close(channel);
      yield* Effect.promise(async () => {
        const url = bridge.origins.tunnel.replace(/^http/, "ws") + "/api/preview/tunnel?port=5173";
        const socket = new NodeWS.WebSocket(url);
        try {
          const opened = new Promise<void>((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
          });
          const media = await bridge.accept();
          const request = new TextDecoder().decode(await bridge.read(media));
          expect(request).toContain("GET /api/preview/tunnel?port=5173 HTTP/1.1");
          const key = /^sec-websocket-key: ([^\r\n]+)$/im.exec(
            request.replaceAll("\r\n", "\n"),
          )![1]!;
          const token = Buffer.from(
            await crypto.subtle.digest(
              "SHA-1",
              new TextEncoder().encode(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"),
            ),
          ).toString("base64");
          await bridge.write(
            media,
            Buffer.from(
              `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${token}\r\n\r\n`,
            ),
          );
          await opened;
          const message = new Promise<Buffer>((resolve) => socket.once("message", resolve));
          await bridge.write(media, Uint8Array.of(0x82, 1, 42));
          expect(new Uint8Array(await message)).toEqual(Uint8Array.of(42));
        } finally {
          socket.terminate();
        }
      });
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
);

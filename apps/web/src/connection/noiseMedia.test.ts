import { expect, it } from "@effect/vitest";
import {
  decodeNoiseMediaFrame,
  encodeNoiseMediaControl,
  encodeNoiseMediaData,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import { makeBrowserMediaTransport } from "./noiseMedia";

function peer() {
  const outbound = new TransformStream<Uint8Array>();
  const sent = outbound.writable.getWriter();
  const receive = outbound.readable.getReader();
  let reply!: ReadableStreamDefaultController<Uint8Array>;
  const inbound = new ReadableStream<Uint8Array>({
    start(controller) {
      reply = controller;
    },
  }).getReader();
  const closed = Promise.withResolvers<void>();
  const lifetime = new AbortController();
  const socket = Socket.make({
    reader: Effect.succeed({
      upgrade: Socket.SocketUpgradeError.unsupported,
      pull: Effect.promise(async () => [(await inbound.read()).value!] as const),
    }),
    writer: Effect.succeed({
      write: (bytes) =>
        bytes instanceof Uint8Array
          ? Effect.promise(() => sent.write(bytes))
          : Effect.die("unexpected frame"),
      writeAll: () => Effect.die("unexpected writeAll"),
    }),
  });
  const open = Effect.acquireRelease(Effect.succeed({ socket }), () =>
    Effect.sync(() => closed.resolve()),
  );
  return {
    media: makeBrowserMediaTransport(open, lifetime.signal),
    closed: closed.promise,
    stop: () => lifetime.abort(),
    send: (frame: Uint8Array) => reply.enqueue(frame),
    read: async () => decodeNoiseMediaFrame((await receive.read()).value!),
  };
}
const http = "https://noise.invalid/api/preview-stream/upload?id=one";
it("streams a multipart upload and only completes a download after its authenticated end", async () => {
  const host = peer();
  const form = new FormData();
  form.append("file", new File(["example"], "test.txt"));
  const response = host.media.fetch(http, {
    method: "POST",
    headers: { authorization: "Bearer do-not-transfer" },
    body: form,
  });
  expect(await host.read()).toEqual({
    kind: "control",
    control: {
      op: "http",
      path: "/api/preview-stream/upload?id=one",
      method: "POST",
      headers: { "content-type": expect.stringMatching(/^multipart\/form-data; boundary=/) },
    },
  });
  const decoder = new TextDecoder();
  let content = "";
  while (true) {
    const frame = await host.read();
    if (frame?.kind === "control" && frame.control.op === "end") break;
    if (frame?.kind !== "binary") throw new Error("expected upload bytes");
    content += decoder.decode(frame.bytes, { stream: true });
  }
  expect(content).toContain('filename="test.txt"');
  expect(content).toContain("example");
  host.send(encodeNoiseMediaControl({ op: "response", status: 200, headers: {} }));
  const result = await response;
  host.send(encodeNoiseMediaData(new TextEncoder().encode("hello")));
  const reader = result.body!.getReader();
  expect((await reader.read()).value).toEqual(new TextEncoder().encode("hello"));
  host.stop();
  await expect(reader.read()).rejects.toThrow();
  await host.closed;
  await expect(host.media.fetch("https://relay.test/api/device-hub/ws")).rejects.toThrow();
});

it("completes a signed asset download only after its host confirms the end", async () => {
  const host = peer();
  const result = host.media.fetch("https://noise.invalid/api/assets/signed/hello.txt");
  expect(await host.read()).toMatchObject({
    kind: "control",
    control: { op: "http", method: "GET", path: "/api/assets/signed/hello.txt" },
  });
  host.send(
    encodeNoiseMediaControl({
      op: "response",
      status: 200,
      headers: { "content-type": "text/plain" },
    }),
  );
  host.send(encodeNoiseMediaData(new TextEncoder().encode("signed bytes")));
  const text = (await result).text();
  host.send(encodeNoiseMediaControl({ op: "end" }));
  expect(await text).toBe("signed bytes");
  await host.closed;
});

it("delivers websocket messages in both directions and closes with the environment session", async () => {
  const host = peer();
  const socket = host.media.openSocket("wss://noise.invalid/api/preview-stream/ws?tabId=T");
  const opened = Promise.withResolvers<void>();
  const received = Promise.withResolvers<ArrayBuffer>();
  const closed = Promise.withResolvers<number>();
  socket.onopen = () => opened.resolve();
  socket.addEventListener("message", (event) => received.resolve(event.data));
  socket.onclose = (event) => closed.resolve(event.code);
  expect(await host.read()).toEqual({
    kind: "control",
    control: { op: "ws", path: "/api/preview-stream/ws?tabId=T" },
  });
  host.send(encodeNoiseMediaControl({ op: "open" }));
  await opened.promise;
  socket.send("pointer");
  expect(await host.read()).toEqual({ kind: "text", text: "pointer" });
  const frame = new Uint8Array(70000).fill(197);
  host.send(encodeNoiseMediaData(frame));
  expect(new Uint8Array(await received.promise)).toEqual(frame);
  host.stop();
  expect(await closed.promise).toBe(1006);
  await host.closed;
});

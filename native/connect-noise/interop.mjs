import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeZlib from "node:zlib";
import { initSync, NoisePeer } from "../../packages/shared/src/_generated/noise.js";
import binary from "../../packages/shared/src/_generated/noise.json" with { type: "json" };

const glue = new URL("../../packages/shared/src/_generated/noise.js", import.meta.url);
const wasm = Buffer.from(binary, "base64");
initSync({ module: wasm });

// Synthetic snapshot only. Credentials, challenges and interactive records never share a compressor.
const snapshot = Buffer.from(
  JSON.stringify(
    Array.from({ length: 256 }, (_, seq) => ({
      seq,
      threadId: `thread-${seq % 8}`,
      text: `工具返回第 ${seq} 行。\n`,
    })),
  ),
);
const compressed = NodeZlib.deflateSync(snapshot, { level: 1 });

// This function also runs in the sandboxed renderer via Playwright.
async function clientRoundTrip({ Peer = globalThis.Peer, key, url }) {
  const client = Peer.client("interop", Uint8Array.from(key));
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  try {
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error("WebSocket failed to open"));
    });
    const send = (plaintext) =>
      new Promise((resolve, reject) => {
        socket.onmessage = ({ data }) => resolve(new Uint8Array(data));
        socket.onclose = ({ code }) => reject(new Error("WebSocket closed: " + code));
        socket.send(client.write(plaintext));
      });
    const challenge = client.read(await send(new Uint8Array()));
    const bytes = client.read(await send(challenge));
    const reader = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream("deflate"))
      .getReader();
    const snapshot = new Uint8Array(65_519);
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (length + value.byteLength > snapshot.length)
          throw new Error("snapshot exceeds record limit");
        snapshot.set(value, length);
        length += value.byteLength;
      }
    } finally {
      await reader.cancel();
    }
    if (client.read(await send(snapshot.subarray(0, length))).length)
      throw new Error("expected empty acknowledgement");
  } finally {
    socket.close();
    client.free();
  }
}

async function rendererRoundTrip(kind, key, url) {
  const webRequire = NodeModule.createRequire(
    new URL("../../apps/web/package.json", import.meta.url),
  );
  const { chromium, _electron } = webRequire("playwright");
  let runtime;
  let profile;
  try {
    let page;
    if (kind === "electron") {
      const desktopRequire = NodeModule.createRequire(
        new URL("../../apps/desktop/package.json", import.meta.url),
      );
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      profile = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-noise-electron-"));
      runtime = await _electron.launch({
        executablePath: desktopRequire("electron"),
        env,
        args: [
          "--user-data-dir=" + profile,
          NodeURL.fileURLToPath(new URL("./examples/interop-electron.cjs", import.meta.url)),
        ],
      });
      page = await runtime.firstWindow();
    } else {
      runtime = await chromium.launch();
      page = await runtime.newPage();
    }
    await page.goto(url.replace("ws:", "http:"));
    await page.evaluate(async () => {
      const { default: init, NoisePeer } = await import("/noise.js");
      await init({ module_or_path: "/noise.wasm" });
      globalThis.Peer = NoisePeer;
    });
    await page.evaluate(clientRoundTrip, { key: Array.from(key), url });
  } finally {
    await runtime?.close();
    if (profile) await NodeFSP.rm(profile, { recursive: true, force: true });
  }
}

const [runtime = "node", host = "127.0.0.1", command, ...args] = process.argv.slice(2);
const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("x25519");
const key = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
const privateBytes = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
const server = NoisePeer.server("interop", privateBytes);
privateBytes.fill(0);
const challenge = NodeCrypto.randomBytes(32);
let step = 0;
let rawRecordBytes;
let compressedRecordBytes;
const exchange = (record) => {
  const data = Buffer.from(server.read(record));
  switch (++step) {
    case 1:
      NodeAssert.equal(data.length, 0);
      return server.write(challenge);
    case 2: {
      NodeAssert.deepEqual(data, challenge);
      const encrypted = server.write(compressed);
      compressedRecordBytes = encrypted.length;
      return encrypted;
    }
    case 3:
      NodeAssert.deepEqual(data, snapshot);
      rawRecordBytes = record.length;
      return server.write(new Uint8Array());
    default:
      throw new Error("unexpected interop record");
  }
};
const serverRequire = NodeModule.createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
);
const { WebSocketServer } = serverRequire("@effect/platform-node/NodeWS");
const files = new Map([
  ["/", ["text/html", "<title>Noise interop</title>"]],
  ["/noise.js", ["text/javascript", await NodeFSP.readFile(glue)]],
  ["/noise.wasm", ["application/wasm", wasm]],
]);
const http = NodeHttp.createServer((request, response) => {
  const file = files.get(request.url);
  if (file) response.writeHead(200, { "Content-Type": file[0] }).end(file[1]);
  else response.writeHead(404).end();
});
const listener = new WebSocketServer({
  server: http,
  maxPayload: 65_535,
  perMessageDeflate: false,
});
let serverError;
listener.once("connection", (socket) => {
  socket.on("message", (record, binary) => {
    try {
      NodeAssert.ok(binary);
      socket.send(exchange(record));
    } catch (error) {
      serverError = error;
      socket.terminate();
    }
  });
});
try {
  http.listen(0, "127.0.0.1");
  await NodeEvents.once(http, "listening");
  const url = "ws://" + host + ":" + http.address().port;
  if (runtime === "node") await clientRoundTrip({ Peer: NoisePeer, key, url });
  else if (runtime === "chromium" || runtime === "electron")
    await rendererRoundTrip(runtime, key, url);
  else if (runtime === "native" && command) {
    const proc = NodeChildProcess.spawn(command, [...args, url, key.toString("hex")], {
      stdio: "inherit",
    });
    const [code] = await NodeEvents.once(proc, "close");
    NodeAssert.equal(code, 0);
  } else
    throw new Error("Use node, chromium, electron, or native <host> <client command> [args...]");
  NodeAssert.equal(step, 3);
  console.log(
    JSON.stringify({
      runtime,
      suite: "Noise_NK_25519_ChaChaPoly_SHA256",
      wasmBytes: wasm.length,
      snapshotBytes: snapshot.length,
      rawRecordBytes,
      compressedRecordBytes,
    }),
  );
} catch (error) {
  throw serverError ?? error;
} finally {
  for (const socket of listener.clients) socket.terminate();
  await new Promise((resolve) => listener.close(resolve));
  await new Promise((resolve) => http.close(resolve));
  server.free();
}

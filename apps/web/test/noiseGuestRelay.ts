import { WebSocket, WebSocketServer } from "@effect/platform-node/NodeWS";
import { initializeConnectNoise, NoisePeer } from "@t3tools/shared/connectNoiseWasm";
import {
  decodeNoiseMediaFrame,
  encodeNoiseMediaControl,
  encodeNoiseMediaData,
} from "@t3tools/contracts";
import type { Page } from "playwright";

const active = new WeakMap<Page, () => Promise<{ posts: string[]; plaintext: boolean }>>();

export async function startGuestRelay(page: Page, events: string[]) {
  await initializeConnectNoise();
  const keys = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  if (!("privateKey" in keys)) throw new Error("Missing Noise host keys");
  const pin = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString(
    "base64url",
  );
  const exported = await crypto.subtle.exportKey("jwk", keys.privateKey);
  const secret = Buffer.from(exported.d!, "base64url");
  const host = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    host.once("listening", resolve);
    host.once("error", reject);
  });
  const port = host.address();
  if (typeof port !== "object" || !port) throw new Error("No loopback endpoint");
  const relay =
    "https://" + Buffer.from(pin, "base64url").toString("hex").slice(0, 32) + ".invalid";
  const shareId = "noise-guest-fixture",
    credential = shareId + ".one-time-private-invite",
    token = "private-guest-session";
  const posts: string[] = [];
  let redeemed = false,
    plaintext = false;
  const sensitive = [
    credential,
    token,
    "Fix login",
    "/api/guest/",
    "private attachment",
    "encrypted output",
    "private chart",
  ];
  const inspect = (bytes: Buffer) => {
    plaintext ||= sensitive.some((text) => bytes.includes(text));
  };

  // Playwright directs this reserved WSS origin to the loopback host without trusting a test CA.
  await page.routeWebSocket(relay.replace(/^http/, "ws") + "/api/connect/e2ee/v1", (client) => {
    const upstream = new WebSocket("ws://127.0.0.1:" + port.port);
    const pending: Buffer[] = [];
    client.onMessage((data) => {
      const bytes = Buffer.from(data);
      inspect(bytes);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes);
      else pending.push(bytes);
    });
    upstream.on("open", () => {
      for (const value of pending) upstream.send(value);
    });
    upstream.on("message", (data) => {
      const bytes = Buffer.from(data as Buffer);
      inspect(bytes);
      client.send(bytes);
    });
    upstream.on("error", () => client.close());
    upstream.on("close", () => client.close());
    client.onClose(() => {
      if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
    });
  });

  host.on("connection", (socket) => {
    const peer = NoisePeer.server("guest-fixture", secret);
    let step = 0,
      path = "",
      body = "";
    function send(frame: Uint8Array) {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(frame.length);
      socket.send(peer.write(Buffer.concat([header, frame])));
    }
    socket.on("close", () => peer.free());
    socket.on("message", (record) => {
      try {
        const bytes = Buffer.from(peer.read(record as Buffer));
        if (step++ === 0) {
          socket.send(peer.write(crypto.getRandomValues(new Uint8Array(32))));
          return;
        }
        if (step === 2) {
          const request = JSON.parse(bytes.toString());
          if (
            !redeemed &&
            request.mode === "guest-redeem" &&
            request.credential === credential &&
            request.name === "Sam"
          ) {
            redeemed = true;
            socket.send(
              peer.write(Buffer.from(JSON.stringify({ status: "guest-redeemed", shareId, token }))),
            );
          } else if (
            redeemed &&
            request.mode === "guest-session" &&
            request.token === token &&
            request.shareId === shareId
          )
            socket.send(peer.write(Buffer.from('{"status":"guest-ready"}')));
          else socket.send(peer.write(Buffer.from('{"status":"rejected"}')));
          return;
        }
        if (bytes.readUInt32BE(0) !== bytes.length - 4)
          throw new Error("Unexpected fixture message size");
        const frame = decodeNoiseMediaFrame(bytes.subarray(4));
        if (frame?.kind === "binary") {
          body += Buffer.from(frame.bytes).toString();
          return;
        }
        if (frame?.kind !== "control") throw new Error("Invalid guest control");
        if (frame.control.op === "end" && path.startsWith("/api/guest/messages?")) {
          posts.push(body);
          send(encodeNoiseMediaControl({ op: "response", status: 204, headers: {} }));
          send(encodeNoiseMediaControl({ op: "end" }));
          return;
        }
        if (frame.control.op !== "http") throw new Error("Unexpected guest request");
        path = frame.control.path;
        if (path.startsWith("/api/guest/messages?")) return;
        const reply = (contentType: string, payload: string, finished: boolean) => {
          send(
            encodeNoiseMediaControl({
              op: "response",
              status: 200,
              headers: { "content-type": contentType },
            }),
          );
          send(encodeNoiseMediaData(Buffer.from(payload)));
          if (finished) send(encodeNoiseMediaControl({ op: "end" }));
        };
        if (path.startsWith("/api/guest/stream?")) {
          reply(
            "text/event-stream",
            events.map((event) => "data: " + event + "\n\n").join(""),
            false,
          );
        } else if (path.startsWith("/api/guest/command-output?")) {
          reply(
            "text/event-stream",
            'data: {"kind":"replace","text":"encrypted output","truncated":false,"running":false}\n\n',
            true,
          );
        } else if (path.startsWith("/api/guest/render?")) {
          reply("text/html; charset=utf-8", "<h1>private chart</h1>", true);
        } else {
          const session = path.startsWith("/api/guest/session?");
          send(
            encodeNoiseMediaControl({ op: "response", status: session ? 204 : 404, headers: {} }),
          );
          send(encodeNoiseMediaControl({ op: "end" }));
        }
      } catch {
        socket.close(1002);
      }
    });
  });
  const close = async () => {
    active.delete(page);
    page.removeListener("close", close);
    for (const socket of host.clients) socket.terminate();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    secret.fill(0);
    return { posts, plaintext };
  };
  active.set(page, close);
  page.once("close", close);
  return (
    "#" + new URLSearchParams({ noise: "1", env: "guest-fixture", pin, relay, invite: credential })
  );
}
export async function stopGuestRelay(page: Page) {
  const close = active.get(page);
  if (!close) throw new Error("Test guest relay is not running");
  return close();
}

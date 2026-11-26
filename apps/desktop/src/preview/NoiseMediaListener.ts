import * as NodeNet from "node:net";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { LocalNoiseMediaListener } from "@t3tools/contracts";

const routes = {
  asset: "/api/assets/",
  device: "/api/device-hub/",
  browser: "/api/preview-stream/",
  tunnel: "/api/preview/tunnel",
} as const;
const headerLimit = 32 * 1024;

interface Channel {
  socket: NodeNet.Socket;
  reader: AsyncIterator<Buffer>;
  first?: Uint8Array;
  responseHead?: Buffer;
}

export async function createNoiseMediaListener(origin: string): Promise<LocalNoiseMediaListener> {
  const channels = new Map<number, Channel>();
  const ready: number[] = [];
  let waiting: ReturnType<typeof Promise.withResolvers<number>> | undefined;
  let sequence = 0;
  let closed = false;
  const prefixes = Object.fromEntries(
    Object.keys(routes).map((key) => [key, "/" + SecureRandom.uuidV4Unsafe()]),
  ) as Record<keyof typeof routes, string>;
  const server = NodeNet.createServer({ allowHalfOpen: false }, (socket) => {
    if (closed || channels.size >= 32) {
      socket.destroy();
      return;
    }
    const id = ++sequence;
    const reader: AsyncIterator<Buffer> = socket[Symbol.asyncIterator]();
    const channel: Channel = { socket, reader, responseHead: Buffer.alloc(0) };
    channels.set(id, channel);
    socket.setTimeout(10000, () => socket.destroy());
    socket.once("close", () => channels.delete(id));
    const admit = async () => {
      let head = Buffer.alloc(0);
      let end: number;
      while ((end = head.indexOf("\r\n\r\n")) < 0) {
        if (head.length >= headerLimit) throw new Error("Invalid local media header");
        const chunk = await reader.next();
        if (chunk.done) throw new Error("Closed local media connection");
        head = Buffer.concat([head, chunk.value]);
      }
      if (end > headerLimit) throw new Error("Invalid local media header");
      const [line, ...headerLines] = head.subarray(0, end).toString("latin1").split("\r\n");
      const match = /^(GET|HEAD|POST|OPTIONS) (\/[^\s]+) HTTP\/1\.1$/.exec(line ?? "");
      if (!match) throw new Error("Invalid local media request");
      const [method, path] = [match[1]!, match[2]!];
      const role = (Object.keys(routes) as (keyof typeof routes)[]).find((key) =>
        key === "tunnel"
          ? path.startsWith(prefixes.tunnel + routes.tunnel + "?")
          : path.startsWith(prefixes[key] + routes[key]),
      );
      if (!role) throw new Error("Unknown local media capability");
      const readHeaders = (name: string) =>
        headerLines
          .filter((line) => line.toLowerCase().startsWith(name + ":"))
          .map((line) => line.slice(name.length + 1).trim());
      const hosts = readHeaders("host");
      const origins = readHeaders("origin");
      if (
        hosts.length !== 1 ||
        hosts[0] !== `127.0.0.1:${port}` ||
        origins.length > 1 ||
        (origins.length && origins[0] !== origin)
      )
        throw new Error("Invalid local media origin");
      if (method === "OPTIONS") {
        socket.end(
          `HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: ${origin}\r\nAccess-Control-Allow-Methods: GET, HEAD, POST\r\nAccess-Control-Allow-Headers: content-type, range, if-range\r\nAccess-Control-Allow-Private-Network: true\r\nConnection: close\r\n\r\n`,
        );
        return;
      }
      // One admitted request owns one encrypted media socket, including a WS upgrade.
      channel.first = Buffer.concat([
        Buffer.from(
          `${method} ${path.slice(prefixes[role].length)} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`,
          "latin1",
        ),
        head.subarray(end + 4),
      ]);
      socket.setTimeout(0);
      if (waiting) {
        waiting.resolve(id);
        waiting = undefined;
      } else ready.push(id);
    };
    void admit().catch(() => socket.destroy());
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || !address)
        return reject(new Error("Missing loopback address"));
      resolve(address.port);
    });
  });
  const origins = Object.fromEntries(
    Object.entries(prefixes).map(([key, value]) => [key, `http://127.0.0.1:${port}${value}`]),
  ) as LocalNoiseMediaListener["origins"];
  function channelFor(id: number) {
    const channel = channels.get(id);
    if (!channel) throw new Error("Local media channel closed");
    return channel;
  }
  return {
    origins,
    accept: async () => {
      while (ready.length) {
        const next = ready.shift()!;
        if (channels.has(next)) return next;
      }
      if (closed || waiting) throw new Error("Listener unavailable");
      waiting = Promise.withResolvers<number>();
      return waiting.promise;
    },
    read: async (id) => {
      const channel = channelFor(id);
      if (channel.first) {
        const first = channel.first;
        delete channel.first;
        return new Uint8Array(first);
      }
      const chunk = await channel.reader.next();
      return chunk.done ? new Uint8Array() : new Uint8Array(chunk.value);
    },
    write: async (id, bytes) => {
      const channel = channelFor(id);
      if (channel.responseHead) {
        const head = Buffer.concat([channel.responseHead, bytes]);
        const end = head.indexOf("\r\n\r\n");
        if ((end < 0 ? head.length : end) > headerLimit) throw new Error("Invalid media response");
        if (end < 0) {
          channel.responseHead = head;
          return;
        }
        delete channel.responseHead;
        const lines = head
          .subarray(0, end)
          .toString("latin1")
          .split("\r\n")
          .filter((line) => !/^access-control-/i.test(line));
        lines.push("Access-Control-Allow-Origin: " + origin);
        bytes = Buffer.concat([
          Buffer.from(lines.join("\r\n") + "\r\n\r\n", "latin1"),
          head.subarray(end + 4),
        ]);
      }
      await new Promise<void>((resolve, reject) =>
        channel.socket.write(bytes, (error) => (error ? reject(error) : resolve())),
      );
    },
    close: (id) => {
      channels.get(id)?.socket.destroy();
    },
    release: () => {
      if (closed) return;
      closed = true;
      waiting?.reject(new Error("Local media listener closed"));
      waiting = undefined;
      ready.length = 0;
      for (const { socket } of channels.values()) socket.destroy();
      channels.clear();
      server.close();
    },
  };
}

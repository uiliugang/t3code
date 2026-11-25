import { fetchNoiseHttp } from "@t3tools/shared/noiseHttpFetch";
import type {
  DeviceMediaSocket,
  DeviceMediaTransport,
} from "@t3tools/client-runtime/device/hub-access";
import {
  isNoiseGuestRoute,
  decodeNoiseMediaFrame,
  encodeNoiseMediaControl,
  encodeNoiseMediaData,
  NOISE_MEDIA_MAX_MESSAGE_BYTES,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Socket from "effect/socket/Socket";

type OpenMedia<E> = Effect.Effect<{ readonly socket: Socket.Socket }, E, Scope.Scope>;
class BrowserMediaError extends Schema.TaggedError<
  BrowserMediaError,
  { readonly brand: unique symbol }
>()("BrowserMediaError", { cause: Schema.optionalKey(Schema.Defect()) }) {
  override get message() {
    return "Invalid encrypted media response";
  }
}
const invalid = () => new BrowserMediaError({});

function pathFrom(
  url: string,
  scheme: "https:" | "wss:",
  guest?: { share: string; method: string },
) {
  const target = new URL(url);
  if (
    target.protocol !== scheme ||
    target.host !== "noise.invalid" ||
    target.username ||
    target.password ||
    target.hash ||
    (guest
      ? !isNoiseGuestRoute(guest.method, target.pathname + target.search, guest.share)
      : !/^\/api\/(device-hub|preview-stream)\//.test(target.pathname) &&
        !(scheme === "https:" && target.pathname.startsWith("/api/assets/")))
  )
    throw invalid();
  return target.pathname + target.search;
}

function mediaFetch<E>(
  open: OpenMedia<E>,
  lifetime: AbortSignal,
  url: string,
  init?: RequestInit,
  guestShare?: string,
): Promise<Response> {
  const request = new Request(url, init);
  const path = pathFrom(
    url,
    "https:",
    guestShare ? { share: guestShare, method: request.method } : undefined,
  );
  const method = request.method;
  if (method === "POST" && path.startsWith("/api/assets/")) return Promise.reject(invalid());
  if (method !== "GET" && method !== "HEAD" && method !== "POST") return Promise.reject(invalid());
  const headers: Record<string, string> = {};
  for (const key of ["accept", "content-type", "range", "if-range"]) {
    const value = request.headers.get(key);
    if (value !== null) headers[key] = value;
  }
  return fetchNoiseHttp(open, lifetime, request, path, method, headers);
}

class BrowserMediaSocket<E> implements DeviceMediaSocket {
  readyState: number = WebSocket.CONNECTING;
  binaryType: BinaryType = "arraybuffer";
  onopen: DeviceMediaSocket["onopen"] = null;
  onclose: DeviceMediaSocket["onclose"] = null;
  onmessage: DeviceMediaSocket["onmessage"] = null;
  onerror: DeviceMediaSocket["onerror"] = null;
  private readonly events = new EventTarget();
  private readonly stop = new AbortController();
  private write?: Socket.Writer["write"];
  private pending = Promise.resolve();
  private buffered = 0;

  constructor(open: OpenMedia<E>, lifetime: AbortSignal, url: string) {
    const path = pathFrom(url, "wss:");
    const signal = AbortSignal.any([lifetime, this.stop.signal]);
    const exchange = Effect.gen({ self: this }, function* () {
      const { socket } = yield* open;
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      this.write = writer.write;
      yield* writer.write(encodeNoiseMediaControl({ op: "ws", path }));
      while (true) {
        for (const raw of yield* reader.pull) {
          const frame = typeof raw === "string" ? null : decodeNoiseMediaFrame(raw);
          if (!frame) throw invalid();
          if (frame.kind === "control") {
            if (frame.control.op === "close") {
              this.finish(frame.control.code ?? 1000, frame.control.reason ?? "");
              return;
            }
            if (frame.control.op !== "open" || this.readyState !== WebSocket.CONNECTING)
              throw invalid();
            this.readyState = WebSocket.OPEN;
            const event = new Event("open");
            this.onopen?.(event);
            this.events.dispatchEvent(event);
          } else {
            if (this.readyState !== WebSocket.OPEN) throw invalid();
            const data =
              frame.kind === "text"
                ? frame.text
                : this.binaryType === "blob"
                  ? new Blob([frame.bytes.slice()])
                  : frame.bytes.slice().buffer;
            const event = new MessageEvent("message", { data });
            this.onmessage?.(event);
            this.events.dispatchEvent(event);
          }
        }
      }
    });
    void Effect.runPromise(Effect.scoped(exchange), { signal }).catch(() => this.fail());
  }

  addEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (event: WebSocketEventMap[K]) => void,
  ) {
    this.events.addEventListener(type, listener as EventListener);
  }

  send(data: string | Uint8Array<ArrayBuffer>) {
    const write = this.write;
    if (this.readyState !== WebSocket.OPEN || !write)
      throw new DOMException("Socket is closed", "InvalidStateError");
    const frame = encodeNoiseMediaData(data);
    if (this.buffered + frame.byteLength > NOISE_MEDIA_MAX_MESSAGE_BYTES + 1) {
      this.fail();
      return;
    }
    this.buffered += frame.byteLength;
    this.pending = this.pending
      .then(async () => {
        try {
          if (this.readyState === WebSocket.OPEN)
            await Effect.runPromise(write(frame), { signal: this.stop.signal });
        } finally {
          this.buffered -= frame.byteLength;
        }
      })
      .catch(() => this.fail());
  }
  close() {
    this.finish(1000, "");
  }
  private fail() {
    if (this.readyState === WebSocket.CLOSED) return;
    const event = new Event("error");
    this.onerror?.(event);
    this.events.dispatchEvent(event);
    this.finish(1006, "");
  }
  private finish(code: number, reason: string) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.stop.abort();
    const event = new CloseEvent("close", { code, reason, wasClean: code === 1000 });
    this.onclose?.(event);
    this.events.dispatchEvent(event);
  }
}

export const makeBrowserMediaTransport = <E>(
  open: OpenMedia<E>,
  lifetime: AbortSignal,
): DeviceMediaTransport => ({
  fetch: async (url, init) => mediaFetch(open, lifetime, url, init),
  openSocket: (url) => new BrowserMediaSocket(open, lifetime, url),
});

export const makeNoiseGuestFetch =
  <E>(open: OpenMedia<E>, lifetime: AbortSignal, shareId: string) =>
  (url: string, init?: RequestInit) =>
    mediaFetch(open, lifetime, url, init, shareId);

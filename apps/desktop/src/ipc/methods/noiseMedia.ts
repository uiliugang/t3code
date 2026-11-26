import { webContents } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { LocalNoiseMediaListener } from "@t3tools/contracts";
import { createNoiseMediaListener } from "../../preview/NoiseMediaListener.ts";
import { NOISE_MEDIA_CHANNEL } from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

let nextListener = 0;
const listeners = new Map<
  string,
  { owner: number; media: LocalNoiseMediaListener; release(): void }
>();
const channel = { listener: Schema.String, id: Schema.Number };
class MediaListenerError extends Schema.TaggedError<
  MediaListenerError,
  { readonly brand: unique symbol }
>()("MediaListenerError", {}) {}

export const noiseMedia = makeIpcMethod({
  channel: NOISE_MEDIA_CHANNEL,
  payload: Schema.Union([
    Schema.Struct({ op: Schema.Literal("open") }),
    Schema.Struct({ op: Schema.Literals(["accept", "release"]), listener: Schema.String }),
    Schema.Struct({ op: Schema.Literals(["read", "close"]), ...channel }),
    Schema.Struct({ op: Schema.Literal("write"), ...channel, bytes: Schema.Uint8Array }),
  ]),
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.noiseMedia")(function* (request, event) {
    const sender = event && webContents.fromId(event.sender.id);
    if (!sender) return yield* new MediaListenerError();
    return yield* Effect.tryPromise({
      try: async () => {
        if (request.op === "open") {
          const url = new URL(sender.getURL());
          const origin = url.protocol + "//" + url.host;
          const media = await createNoiseMediaListener(origin);
          if (sender.isDestroyed() || sender.getURL() !== url.href) {
            media.release();
            throw new MediaListenerError();
          }
          const listener = String(++nextListener);
          const release = () => {
            listeners.delete(listener);
            if (!sender.isDestroyed()) {
              sender.removeListener("did-navigate", release);
              sender.removeListener("render-process-gone", release);
              sender.removeListener("destroyed", release);
            }
            media.release();
          };
          sender.once("did-navigate", release);
          sender.once("render-process-gone", release);
          sender.once("destroyed", release);
          listeners.set(listener, { owner: sender.id, media, release });
          return { listener, origins: media.origins };
        }
        const saved = listeners.get(request.listener);
        if (!saved || saved.owner !== sender.id) throw new MediaListenerError();
        switch (request.op) {
          case "release":
            return saved.release();
          case "accept":
            return saved.media.accept();
          case "read":
            return saved.media.read(request.id);
          case "write":
            return saved.media.write(request.id, request.bytes);
          case "close":
            return saved.media.close(request.id);
        }
      },
      catch: () => new MediaListenerError(),
    });
  }),
});

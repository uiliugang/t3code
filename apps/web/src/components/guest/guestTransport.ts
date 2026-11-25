import { ASSET_URL_MAX_IN_FLIGHT } from "@t3tools/client-runtime/state/assets";
import * as Semaphore from "effect/Semaphore";
import { GUEST_ROUTE_PREFIX } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { observeMediaEvents } from "~/lib/mediaEventSource";
import { Atom, AsyncResult } from "effect/reactivity";

import { localAssetUrl } from "~/assets/noiseAsset";
import { isNoiseGuest, noiseGuestFetch } from "~/guest/noiseGuest";

export function guestFetch(path: string, init?: RequestInit) {
  if (isNoiseGuest())
    return noiseGuestFetch(path, init) ?? Promise.reject(new Error("Guest session unavailable"));
  return window.fetch(path, init);
}

export function observeGuestEvents(
  path: string,
  onMessage: (data: string) => void,
  onRejected: () => void,
) {
  return observeMediaEvents(path, isNoiseGuest() ? guestFetch : undefined, onMessage, onRejected);
}

const guestMediaSlots = Semaphore.makeUnsafe(ASSET_URL_MAX_IN_FLIGHT);
const decryptGuestMedia = Atom.family((path: string) =>
  Atom.make((get) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await noiseGuestFetch(path, { signal });
        if (!response?.ok) {
          await response?.body?.cancel();
          throw new Error("Guest media unavailable");
        }
        return response.blob();
      },
      catch: () => "unavailable" as const,
    }).pipe(
      guestMediaSlots.withPermit,
      Effect.flatMap((blob) => localAssetUrl(blob.slice(0, blob.size, blob.type.split(";", 1)[0]))),
      Effect.tap((url) =>
        Effect.sync(() => {
          if (url.startsWith("blob:")) get.addFinalizer(() => URL.revokeObjectURL(url));
        }),
      ),
    ),
  ).pipe(Atom.setIdleTTL("5 seconds")),
);

const mediaUrl = Atom.family((path: string) =>
  Atom.map(decryptGuestMedia(path), (result) =>
    AsyncResult.isSuccess(result) ? result.value : undefined,
  ),
);
const ordinaryUrl = Atom.family((path: string) => Atom.make<string | undefined>(path));
export const guestMediaSource = (path: string) =>
  isNoiseGuest() ? mediaUrl(path) : ordinaryUrl(path);

export async function downloadGuestFile(path: string, name: string) {
  if (!isNoiseGuest()) {
    window.open(path, "_blank", "noopener,noreferrer");
    return;
  }
  if (!path.startsWith(GUEST_ROUTE_PREFIX + "/")) throw new Error("Invalid guest asset");
  const response = await noiseGuestFetch(path);
  if (!response?.ok) {
    await response?.body?.cancel();
    throw new Error("Guest file unavailable");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob.slice(0, blob.size, "application/octet-stream"));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

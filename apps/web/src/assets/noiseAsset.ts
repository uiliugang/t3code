import type { DeviceMediaTransport } from "@t3tools/client-runtime/device/hub-access";
import { AssetCreateUrlResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const signedAssetPath = Schema.is(AssetCreateUrlResult.fields.relativeUrl);
class NoiseAssetError extends Schema.TaggedError<
  NoiseAssetError,
  { readonly brand: unique symbol }
>()("NoiseAssetError", {}) {}
const invalid = () => new NoiseAssetError({});

export const downloadNoiseAsset = Effect.fn("web.downloadNoiseAsset")((
  media: DeviceMediaTransport | undefined,
  path: string,
) => {
  if (!media || !signedAssetPath(path)) return Effect.fail(invalid());
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await media.fetch("https://noise.invalid" + path, { signal });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw invalid();
      }
      const blob = await response.blob();
      return blob.slice(0, blob.size, blob.type.split(";", 1)[0]);
    },
    catch: invalid,
  });
});

export function localAssetUrl(blob: Blob) {
  // Active files need an opaque origin even when opened independently of the sandboxed preview.
  if (blob.type === "text/html" || blob.type === "image/svg+xml") {
    return Effect.tryPromise({
      try: () =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            typeof reader.result === "string" ? resolve(reader.result) : reject(invalid());
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        }),
      catch: invalid,
    });
  }
  const passive =
    /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf|text\/plain)$/i.test(
      blob.type,
    );
  return Effect.sync(() =>
    URL.createObjectURL(passive ? blob : blob.slice(0, blob.size, "application/octet-stream")),
  );
}

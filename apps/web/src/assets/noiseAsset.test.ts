import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { downloadNoiseAsset } from "./noiseAsset";

it.effect(
  "only fetches signed asset paths, and preserves the MIME type for isolated previews",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const media = {
        fetch: async (url: string) => {
          calls++;
          if (!url.endsWith("/allowed.pdf")) return new Response(null, { status: 403 });
          return new Response("pdf", {
            headers: { "content-type": "application/pdf; charset=binary" },
          });
        },
        openSocket: () => {
          throw new Error("Unexpected socket");
        },
      };
      const result = yield* downloadNoiseAsset(media, "/api/assets/token/allowed.pdf");
      expect(result.type).toBe("application/pdf");
      expect(yield* Effect.promise(() => result.text())).toBe("pdf");
      expect(
        (yield* downloadNoiseAsset(media, "/api/assets/token/revoked.pdf").pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      for (const path of [
        "//untrusted.invalid/asset",
        "/api/auth/session",
        "/api/assets/token/../file",
      ]) {
        expect((yield* downloadNoiseAsset(media, path).pipe(Effect.result))._tag).toBe("Failure");
      }
      expect(calls).toBe(2);
    }),
);

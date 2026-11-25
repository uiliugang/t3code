import { NOISE_PREVIEW_ORIGIN } from "@t3tools/shared/preview";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { Page } from "playwright-core";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import { resolveNoisePreviewDocument } from "../assets/AssetAccess.ts";
import { assetFileResponse } from "../http.ts";

export const makeNoisePreviewDocument = Effect.fn("preview.noiseDocument")(function* (
  entry: URL,
  context: string,
  signal: AbortSignal,
) {
  const parts = /^\/api\/assets\/([\w.-]+)\/[^/]+\.(?:html?|pdf)$/i.exec(entry.pathname);
  if (entry.origin !== NOISE_PREVIEW_ORIGIN || !parts) return undefined;
  const token = parts[1]!;
  const prefix = "/api/assets/" + token + "/";
  const fetch = Effect.fn("preview.noiseDocument.read")(function* (
    path: string,
    head: boolean,
    range?: string,
    ifRange?: string,
  ) {
    if (!path.startsWith(prefix)) return null;
    const asset = yield* resolveNoisePreviewDocument(token, path.slice(prefix.length), context);
    if (!asset) return null;
    const http = yield* assetFileResponse(asset, range, ifRange, head ? "HEAD" : "GET");
    const response = HttpServerResponse.toWeb(http, { withoutBody: head, signal });
    const body = Buffer.from(yield* Effect.promise(() => response.arrayBuffer()));
    return { status: response.status, headers: Object.fromEntries(response.headers), body };
  }, Effect.scoped);
  const run = Effect.runPromiseWith(
    yield* Effect.context<Effect.Services<ReturnType<typeof fetch>>>(),
  );
  return {
    entry: entry.href,
    read: (path: string, head: boolean, range?: string, ifRange?: string) =>
      run(fetch(path, head, range, ifRange), { signal }),
  };
}, Effect.provide(NodeHttpPlatform.layer));
export type NoisePreviewDocument = NonNullable<
  Effect.Success<ReturnType<typeof makeNoisePreviewDocument>>
>;

export async function installNoisePreviewDocument(page: Page, document: NoisePreviewDocument) {
  await page.route(NOISE_PREVIEW_ORIGIN + "/**", async (route) => {
    const request = route.request();
    try {
      if (request.method() !== "GET" && request.method() !== "HEAD") return await route.abort();
      const dest = new URL(request.url());
      const pdf = request.isNavigationRequest() && /\.pdf$/i.test(dest.pathname);
      const headers = request.headers();
      const response = await document.read(
        dest.pathname,
        pdf || request.method() === "HEAD",
        headers.range,
        headers["if-range"],
      );
      if (!response) return await route.abort();
      if (pdf && response.headers["content-type"]?.startsWith("application/pdf")) {
        // The PDF viewer belongs to the client; a document commit retains this tab's navigation history.
        return await route.fulfill({
          status: 200,
          headers: {
            "content-type": "text/html",
            "content-security-policy": "default-src 'none'; sandbox",
            "referrer-policy": "no-referrer",
          },
          body: "<!doctype html><title>PDF</title>",
        });
      }
      await route.fulfill({
        ...response,
        headers: {
          ...response.headers,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    } catch {
      await route.abort().catch(() => {});
    }
  });
}

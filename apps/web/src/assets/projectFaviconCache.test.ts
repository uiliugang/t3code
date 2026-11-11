import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

function connection() {
  return Object.assign(new EventTarget(), {
    close: vi.fn(),
    transaction: () => {
      const transaction = Object.assign(new EventTarget(), {
        objectStore: () => ({
          getAll: () => ({ result: [] }),
          put: vi.fn(),
        }),
      });
      queueMicrotask(() => transaction.dispatchEvent(new Event("complete")));
      return transaction;
    },
  });
}

it.each(["error", "blocked"])(
  "retries favicon storage after an open %s and closes abandoned connections",
  async (event) => {
    vi.resetModules();
    const abandoned = connection();
    const recovered = connection();
    const requests: Array<EventTarget & { result: ReturnType<typeof connection>; error: Error }> =
      [];
    const open = vi.fn(() => {
      const request = Object.assign(new EventTarget(), {
        result: requests.length === 0 ? abandoned : recovered,
        error: new Error("Temporary open failure"),
      });
      requests.push(request);
      queueMicrotask(() =>
        request.dispatchEvent(new Event(requests.length === 1 ? event : "success")),
      );
      return request;
    });
    vi.stubGlobal("indexedDB", { open });
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }),
      );
    try {
      const { projectFaviconCache: cache } = await import("./projectFaviconCache.ts");
      await cache.hydrate();
      const target = { environmentId: EnvironmentId.make("fixture"), cwd: "/repo" };
      await cache.resolve(target, "https://fixture/icon.png", new AbortController().signal);
      await cache.flush();
      expect(open).toHaveBeenCalledTimes(2);
      if (event === "blocked") {
        requests[0]!.dispatchEvent(new Event("success"));
        expect(abandoned.close).toHaveBeenCalledOnce();
      }
      recovered.dispatchEvent(new Event("versionchange"));
      expect(recovered.close).toHaveBeenCalledOnce();
      await cache.resolve(target, "https://fixture/changed.png", new AbortController().signal);
      await cache.flush();
      expect(open).toHaveBeenCalledTimes(3);
      recovered.dispatchEvent(new Event("close"));
      await cache.resolve(target, "https://fixture/final.png", new AbortController().signal);
      await cache.flush();
      expect(open).toHaveBeenCalledTimes(4);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

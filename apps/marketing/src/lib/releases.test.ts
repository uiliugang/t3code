import { expect, it, vi } from "vite-plus/test";
import { fetchLatestRelease } from "./releases.ts";

it("does not reuse upstream downloads cached before changing the release repository", async () => {
  const upstream = {
    tag_name: "v99.0.0",
    published_at: "2026-11-01",
    assets: [],
    html_url: "https://github.com/pingdotgg/t3code/releases/tag/v99.0.0",
  };
  const fork = {
    tag_name: "v0.0.8",
    published_at: "2026-11-01",
    assets: [],
    html_url: "https://github.com/uiliugang/t3code/releases/tag/v0.0.8",
  };
  const cached = new Map([["t3code-stable-release", JSON.stringify(upstream)]]);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => cached.get(key) ?? null,
    setItem: (key: string, value: string) => cached.set(key, value),
  });
  using fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(fork));
  try {
    expect(await fetchLatestRelease()).toEqual(fork);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/uiliugang/t3code/releases/latest",
    );
    expect(await fetchLatestRelease()).toEqual(fork);
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("finds a nightly beyond the first page and bounds lookup when no nightly exists", async () => {
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  let missing = false;
  const nightly = {
    tag_name: "v1.2.3-nightly.1",
    assets: [],
    published_at: "2026-11-01",
    html_url: "https://github.com/uiliugang/t3code/releases/tag/v1.2.3-nightly.1",
  };
  using fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const page = new URL(String(input)).searchParams.get("page") ?? "1";
    return Response.json(
      page === "1" || missing
        ? Array.from({ length: 100 }, (_, index) => ({ tag_name: `v1.2.${index}`, assets: [] }))
        : [nightly],
    );
  });
  try {
    expect(await fetchLatestRelease("nightly")).toEqual(nightly);
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockClear();
    missing = true;
    await expect(fetchLatestRelease("nightly")).rejects.toThrow("No nightly release");
    expect(fetch).toHaveBeenCalledTimes(10);
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  "unavailable",
  "corrupt",
  "full",
  "null",
  "{}",
  "invalid-assets",
  "invalid-asset",
] as const)("loads the release when the session cache is %s", async (cache) => {
  const release = {
    tag_name: "v0.0.8",
    assets: [],
    published_at: "2026-11-01",
    html_url: "https://github.com/uiliugang/t3code/releases/tag/v0.0.8",
  };
  vi.stubGlobal("sessionStorage", {
    getItem: () => {
      if (cache === "unavailable") throw new DOMException("Blocked", "SecurityError");
      if (cache === "corrupt") return "invalid JSON";
      if (cache === "invalid-assets") return JSON.stringify({ ...release, assets: {} });
      if (cache === "invalid-asset") return JSON.stringify({ ...release, assets: [null] });
      return cache === "full" ? null : cache;
    },
    setItem: () => {
      if (cache !== "corrupt") throw new DOMException("Blocked", "QuotaExceededError");
    },
  });
  using _fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(release));
  try {
    expect(await fetchLatestRelease()).toEqual(release);
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([200, 403])("rejects stable GitHub errors with status %s", async (status) => {
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ message: "API rate limit exceeded" }, { status }));
  try {
    await expect(fetchLatestRelease()).rejects.toThrow(
      status === 200 ? "Invalid release metadata" : "Release lookup failed (403)",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

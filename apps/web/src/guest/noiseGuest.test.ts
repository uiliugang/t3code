import { expect, it, vi } from "@effect/vitest";
import { isNoiseGuest, noiseGuestFetch, readNoiseGuestEntry } from "./noiseGuest";

const key = "t3code:noise-guest:share";
const route = { env: "test-host", relay: "https://relay.example", pin: "A".repeat(43) };
function fixture(search = "") {
  const records = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => records.set(key, value),
  });
  vi.stubGlobal("window", { location: { origin: "https://fork.example", search } });
  return records;
}
it("never lends a saved guest session to an invitation with a different relay or pin", async () => {
  using _parse = vi.spyOn(URL, "parse").mockImplementation(() => {
    throw new TypeError("URL.parse is not available");
  });
  const records = fixture();
  records.set(key, JSON.stringify({ ...route, token: "secret-session" }));
  try {
    const params = new URLSearchParams({
      ...route,
      noise: "1",
      invite: "share.signed",
      relay: "https://elsewhere.example",
    });
    expect(readNoiseGuestEntry("#" + params, null)).toEqual({
      shareId: "share",
      credential: "share.signed",
    });
    expect(isNoiseGuest()).toBe(true);
    expect(records.get(key)).not.toContain("secret-session");
    expect((await noiseGuestFetch("/api/guest/session?share=share"))?.status).toBe(403);
    expect((await noiseGuestFetch("/api/guest/session?share=different"))?.status).toBe(403);
    expect((await noiseGuestFetch("/api/auth/session"))?.status).toBe(403);
    const stale = new URLSearchParams({
      ...route,
      noise: "1",
      invite: "share.signed",
      pin: "invalid",
    });
    expect(readNoiseGuestEntry("#" + stale, null)?.credential).toBeNull();
    expect(isNoiseGuest()).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});
it("remembers an encrypted tab without a usable stored credential and preserves ordinary guest links", async () => {
  fixture("?share=share&noise=1");
  try {
    expect(readNoiseGuestEntry("", "share")).toEqual({ shareId: "share", credential: null });
    expect((await noiseGuestFetch("/api/guest/session?share=share"))?.status).toBe(403);
    expect(readNoiseGuestEntry("#share.ordinary", null)).toBeNull();
    expect(isNoiseGuest()).toBe(false);
    expect(noiseGuestFetch("/api/guest/session?share=share")).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

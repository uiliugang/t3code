import { afterEach, expect, it, vi } from "vite-plus/test";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

it("falls back to All in another tab when the active Space is deleted", async () => {
  const localStorage = storage();
  vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage }));
  vi.stubGlobal("sessionStorage", storage());
  const {
    SIDEBAR_SPACE_DEFINITIONS,
    readActiveSidebarSpaceId,
    selectActiveSidebarSpace,
    sidebarSpaceCommands,
    subscribeActiveSidebarSpace,
  } = await import("./sidebarSpaceSession");
  localStorage.setItem(
    SIDEBAR_SPACE_DEFINITIONS,
    JSON.stringify([{ id: "work", name: "Work", projectRefs: [] }]),
  );
  selectActiveSidebarSpace("work");
  const openInSpace = vi.fn();
  const unsubscribeCommand = sidebarSpaceCommands.subscribe(openInSpace);
  const observed = vi.fn(() => readActiveSidebarSpaceId());
  const unsubscribeActive = subscribeActiveSidebarSpace(observed);

  expect(readActiveSidebarSpaceId()).toBe("work");
  expect(sidebarSpaceCommands.newThread()).toBe(true);
  expect(openInSpace).toHaveBeenCalledTimes(1);

  // A different tab updates shared definitions but cannot remove this tab's session value.
  localStorage.setItem(SIDEBAR_SPACE_DEFINITIONS, "[]");
  window.dispatchEvent(Object.assign(new Event("storage"), { key: SIDEBAR_SPACE_DEFINITIONS }));

  expect(observed).toHaveReturnedWith(null);
  expect(readActiveSidebarSpaceId()).toBeNull();
  expect(sidebarSpaceCommands.newThread()).toBe(false);
  expect(openInSpace).toHaveBeenCalledTimes(1);

  unsubscribeActive();
  unsubscribeCommand();
});

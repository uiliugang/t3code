import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { beforeEach } from "vite-plus/test";
import { commands } from "vite-plus/test/browser";

import { initializeI18n } from "../src/i18n/initializeI18n";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Defined in vite.config.ts. Moves Playwright's mouse off the page. */
    startGuestRelay: (events: string[]) => Promise<string>;
    stopGuestRelay: () => Promise<{ posts: string[]; plaintext: boolean }>;
    resetPointer: () => Promise<void>;
  }
}

// Playwright's mouse outlives each test and each file, so whatever the next test mounts
// under its last position starts hovered. Registered here rather than in render() so tests
// that mount without it are covered too. Before each test, not after: a timed-out test keeps
// running and can move the mouse after its own afterEach.
beforeEach(async () => {
  await commands.resetPointer();
});

// Browser tests assert the English source text; production defaults to zh-CN.
Object.assign(DEFAULT_CLIENT_SETTINGS, { uiLanguage: "en" });

// The app initializes GT at startup; components using its hooks need the same here.
initializeI18n(() => {});

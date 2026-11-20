import { describe, expect, it } from "vite-plus/test";
import type { ServerProvider } from "@t3tools/contracts";
import {
  canManageProvider,
  needsProviderSummary,
  providerSummaryStatus,
} from "./provider-accounts.logic";

describe("provider account visibility", () => {
  it.each([
    ["codex", true, undefined, true, true, false],
    ["codex", true, true, true, false, true],
    ["claudeAgent", true, undefined, true, false, false],
    ["cursor", true, false, true, true, false],
    ["cursor", true, true, true, false, true],
    ["cursor", false, true, true, true, false],
    ["antigravity", true, true, true, false, true],
    ["antigravity", false, true, true, true, false],
    ["acpRegistry", true, undefined, true, false, true],
    ["acpRegistry", false, undefined, true, true, false],
    ["acpRegistry", true, undefined, false, true, false],
  ] as const)(
    "classifies %s with enabled %s, authentication %s and installed %s",
    (driver, enabled, authenticate, installed, summary, managed) => {
      const provider = {
        driver,
        enabled,
        installed,
        setup: { canAuthenticate: authenticate },
      } as ServerProvider;
      expect(needsProviderSummary(provider)).toBe(summary);
      expect(canManageProvider(provider)).toBe(managed);
    },
  );

  it.each([
    [false, true, "authenticated", "Turned off"],
    [true, false, "authenticated", "Not installed"],
    [true, true, "authenticated", "Signed in"],
    [true, true, "unauthenticated", "Not signed in"],
    [true, true, "unknown", "Unknown"],
  ] as const)(
    "reports enabled %s installed %s authentication %s",
    (enabled, installed, status, expected) => {
      expect(
        providerSummaryStatus({ enabled, installed, auth: { status } } as ServerProvider),
      ).toBe(expected);
    },
  );
});

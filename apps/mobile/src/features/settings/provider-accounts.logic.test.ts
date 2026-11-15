import { describe, expect, it } from "vite-plus/test";
import type { ServerProvider } from "@t3tools/contracts";
import {
  canManageProvider,
  needsProviderSummary,
  providerSummaryStatus,
} from "./provider-accounts.logic";

describe("provider account visibility", () => {
  it.each([
    ["codex", undefined, true, true, false],
    ["codex", true, true, false, true],
    ["claudeAgent", undefined, true, false, false],
    ["cursor", false, true, true, false],
    ["acpRegistry", undefined, true, false, true],
    ["acpRegistry", undefined, false, true, false],
  ] as const)(
    "classifies %s with authentication %s and installed %s",
    (driver, authenticate, installed, summary, managed) => {
      const provider = {
        driver,
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

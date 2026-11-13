import { RunId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { __setClientSettingsForTests } from "../../hooks/useSettings";

const stoppedAt = new Date(2026, 9, 20, 12, 0);

function bannerDescription(
  resetAt: Date,
  timestampFormat: TimestampFormat,
  uiLanguage: "en" | "zh-CN" = "en",
) {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage });
  return usageLimitRecoveryBannerItem({
    runId: RunId.make("run-1"),
    errorCode: null,
    resetAt: resetAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    settled: false,
    requestPending: false,
    snoozedUntil: null,
    recovery: null,
    timestampFormat,
    onChange: async () => {},
  }).description;
}

describe("usageLimitRecoveryBannerItem", () => {
  it.each([
    ["12-hour", "Resets 5:30 PM"],
    ["24-hour", "Resets 17:30"],
  ] as const)("formats a same-day reset with the %s setting", (timestampFormat, expected) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 20, 17, 30), timestampFormat)).toBe(expected);
  });

  it("names the day when the reset is tomorrow", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 21, 17, 30), "24-hour")).toBe(
      "Resets tomorrow at 17:30",
    );
    expect(bannerDescription(new Date(2026, 9, 21, 17, 30), "24-hour", "zh-CN")).toBe(
      "重置时间：明天 17:30",
    );
  });
});

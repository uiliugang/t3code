import { describe, expect, it } from "vite-plus/test";
import { translateUi } from "@t3tools/shared/uiLocale";
import { msUntilRelativeTimeChange, relativeTime } from "./time";

const at = "2026-10-19T12:00:00.000Z";
const timestamp = Date.parse(at);

describe("relative time", () => {
  it.each([
    [59_999, "<1m", "1m", "刚刚", "1分钟"],
    [119_999, "1m", "2m", "1分钟", "2分钟"],
    [3_599_999, "59m", "1h", "59分钟", "1小时"],
    [7_199_999, "1h", "2h", "1小时", "2小时"],
    [86_399_999, "23h", "1d", "23小时", "1天"],
    [172_799_999, "1d", "2d", "1天", "2天"],
  ] as const)(
    "updates at the next boundary after %i ms",
    (elapsed, before, after, zhBefore, zhAfter) => {
      const nowMs = timestamp + elapsed;
      expect(relativeTime(at, nowMs)).toBe(before);
      expect(msUntilRelativeTimeChange(at, nowMs)).toBe(1);
      expect(relativeTime(at, nowMs + 1)).toBe(after);
      const chinese = (message: string, values?: Readonly<Record<string, string | number>>) =>
        translateUi("zh-CN", message, values);
      expect(relativeTime(at, nowMs, chinese)).toBe(zhBefore);
      expect(relativeTime(at, nowMs + 1, chinese)).toBe(zhAfter);
    },
  );

  it.each([
    [0, 60_000],
    [60_000, 60_000],
    [3_600_000, 3_600_000],
    [86_400_000, 86_400_000],
  ])("waits a full label interval at %i ms", (elapsed, delay) => {
    expect(msUntilRelativeTimeChange(at, timestamp + elapsed)).toBe(delay);
  });

  it("keeps invalid timestamps static", () => {
    expect(relativeTime("invalid", timestamp)).toBe("<1m");
    expect(msUntilRelativeTimeChange("invalid", timestamp)).toBeNull();
  });

  it("waits until a future timestamp is a minute old, with bounded timers", () => {
    expect(relativeTime(at, timestamp - 30_000)).toBe("<1m");
    expect(msUntilRelativeTimeChange(at, timestamp - 30_000)).toBe(90_000);
    expect(msUntilRelativeTimeChange(at, timestamp - 30 * 86_400_000)).toBe(86_400_000);
  });
});

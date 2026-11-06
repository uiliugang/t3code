import { translateUi, type UiTranslator } from "@t3tools/shared/uiLocale";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatScheduledTaskInterval(
  everyMs: number,
  t: UiTranslator = translateUi.bind(null, "en"),
): string {
  const units = [
    [7 * DAY, "week"],
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
    [1_000, "second"],
    [1, "millisecond"],
  ] as const;
  let remaining = everyMs;
  const parts: string[] = [];
  for (const [size, unit] of units) {
    const count = Math.floor(remaining / size);
    if (count === 0) continue;
    if (count === 1 && remaining === everyMs && remaining === size) return t(`Every ${unit}`);
    parts.push(t(`{count} ${unit}${count === 1 ? "" : "s"}`, { count }));
    remaining %= size;
  }
  return t("Every {interval}", { interval: parts.join(" ") });
}

function localCalendarDay(date: Date): number {
  // Compare calendar days, not 24-hour spans: DST days can have 23 or 25 hours.
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

export function formatNextScheduledTaskRun(
  nextRunAt: string,
  now: number,
  t: UiTranslator = translateUi.bind(null, "en"),
): string {
  const next = new Date(nextRunAt);
  const current = new Date(now);
  const remaining = next.getTime() - now;
  if (!Number.isFinite(remaining)) return t("Next run unavailable");
  if (remaining <= 0) return t("Next run due");

  const days = localCalendarDay(next) - localCalendarDay(current);
  if (days === 0) {
    if (remaining < MINUTE) return t("Next run in less than a minute");
    const unit = remaining < HOUR ? "minute" : "hour";
    const count = Math.round(remaining / (remaining < HOUR ? MINUTE : HOUR));
    return t(`Next run in {count} ${unit}${count === 1 ? "" : "s"}`, { count });
  }

  const time = next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return t("Next run tomorrow at {time}", { time });
  if (days <= 7) {
    return t("Next run next {day} at {time}", {
      day: t(next.toLocaleDateString([], { weekday: "long" })),
      time,
    });
  }
  const date = next.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(next.getFullYear() !== current.getFullYear() ? { year: "numeric" as const } : {}),
  });
  return t("Next run {date} at {time}", { date, time });
}

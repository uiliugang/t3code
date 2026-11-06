import type { UiTranslator } from "@t3tools/shared/uiLocale";

export function relativeTime(input: string, nowMs: number = Date.now(), t?: UiTranslator): string {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return t?.("<1m") ?? "<1m";
  }

  const deltaSeconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
  if (deltaSeconds < 60) return t?.("<1m") ?? "<1m";

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return t?.("{count}m", { count: deltaMinutes }) ?? `${deltaMinutes}m`;

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return t?.("{count}h", { count: deltaHours }) ?? `${deltaHours}h`;

  const deltaDays = Math.floor(deltaHours / 24);
  return t?.("{count}d", { count: deltaDays }) ?? `${deltaDays}d`;
}

/** Milliseconds until the relative-time label next changes. */
export function msUntilRelativeTimeChange(
  input: string,
  nowMs: number = Date.now(),
): number | null {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) return null;
  const elapsedMs = Math.max(0, nowMs - timestamp);
  const unitMs = elapsedMs < 3_600_000 ? 60_000 : elapsedMs < 86_400_000 ? 3_600_000 : 86_400_000;
  const nextChangeMs = timestamp + (Math.floor(elapsedMs / unitMs) + 1) * unitMs;
  // Far-future timestamps must not overflow setTimeout's signed 32-bit delay.
  return Math.min(nextChangeMs - nowMs, 86_400_000);
}

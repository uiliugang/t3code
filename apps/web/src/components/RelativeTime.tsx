import { useRelativeTimeState } from "../hooks/useRelativeTimeState";
import { useUiTranslation } from "../hooks/useUiTranslation";

// Use a live clock because the compiler caches inline formatting on the timestamp.
export function RelativeTime(props: { timestamp: string }) {
  const t = useUiTranslation();
  const relative = useRelativeTimeState(props.timestamp, t);
  if (relative.status !== "relative") return null;
  return relative.suffix
    ? t("{value} {suffix}", { value: relative.value, suffix: relative.suffix })
    : relative.value;
}

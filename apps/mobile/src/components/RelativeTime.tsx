import { useSyncExternalStore } from "react";
import { msUntilRelativeTimeChange, relativeTime } from "../lib/time";
import { useUiTranslation } from "../lib/useUiTranslation";

// The React Compiler caches inline relativeTime calls on the timestamp alone.
export function RelativeTime(props: { timestamp: string }) {
  const t = useUiTranslation();
  const subscribe = (onChange: () => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const delayMs = msUntilRelativeTimeChange(props.timestamp);
      if (delayMs === null) return;
      timer = setTimeout(() => {
        onChange();
        schedule();
      }, delayMs);
    };
    schedule();
    return () => clearTimeout(timer);
  };
  const getSnapshot = () => relativeTime(props.timestamp, Date.now(), t);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

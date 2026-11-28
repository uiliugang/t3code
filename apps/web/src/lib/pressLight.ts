import type { PointerEvent } from "react";

/**
 * Tracks the pointer for the `press-light` utility, which draws a soft light under the pointer
 * while a Button is pressed. Spread onto any Button; it has no render-time cost.
 */
export const pressLightProps = {
  onPointerDown(event: PointerEvent<HTMLElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--press-x", `${event.clientX - bounds.left}px`);
    event.currentTarget.style.setProperty("--press-y", `${event.clientY - bounds.top}px`);
  },
} as const;

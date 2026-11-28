export function markInboxArrival(anchor: HTMLElement) {
  for (const animation of anchor.getAnimations()) {
    if (animation.id === "inbox-arrival") animation.cancel();
  }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  anchor.animate(
    [
      { boxShadow: "0 0 0 2px var(--ring)", offset: 0 },
      { boxShadow: "0 0 0 2px var(--ring)", offset: 0.4 },
      { boxShadow: "0 0 0 2px transparent", offset: 1 },
    ],
    { id: "inbox-arrival", duration: 1600, easing: "ease-out" },
  );
}

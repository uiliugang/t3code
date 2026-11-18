import { EraserIcon } from "lucide-react";

import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Shown while `/clear` is armed; dismissing it keeps the current conversation. */
export function freshSessionBannerItem(
  onUndo: () => void,
  t: (message: string) => string,
): ComposerBannerStackItem {
  return {
    id: "fresh-session",
    variant: "info",
    icon: <EraserIcon />,
    title: t("Your next message starts a fresh session"),
    description: t("The agent won't see earlier messages in this thread."),
    dismissLabel: t("Keep the current session"),
    onDismiss: onUndo,
  };
}

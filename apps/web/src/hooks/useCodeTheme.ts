import { useSyncExternalStore } from "react";
import { DIFF_THEME_NAMES, resolveDiffThemeName } from "../lib/diffRendering";
import { getRenderedAppearance, subscribeRenderedAppearance } from "./useTheme";

export function getRenderedCodeTheme() {
  return resolveDiffThemeName(
    getRenderedAppearance(),
    typeof document === "undefined" ? undefined : document.documentElement.dataset.themeId,
  );
}

function getServerCodeTheme() {
  return DIFF_THEME_NAMES.light;
}

export function useCodeTheme(appearance?: "light" | "dark") {
  const theme = useSyncExternalStore(
    subscribeRenderedAppearance,
    getRenderedCodeTheme,
    getServerCodeTheme,
  );
  return appearance === undefined
    ? theme
    : resolveDiffThemeName(
        appearance,
        theme === DIFF_THEME_NAMES.jetbrainsLight || theme === DIFF_THEME_NAMES.jetbrainsDark
          ? "claude-desktop"
          : undefined,
      );
}

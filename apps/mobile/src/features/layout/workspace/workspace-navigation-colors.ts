import {
  flattenThemeColor,
  isDarkThemeColor,
  themeColorWithAlpha,
  themeColorWithContrast,
  type MobileThemeVariables,
} from "../../../lib/mobileTheme";

// A dark page swallows the native shadow, so the fill alone has to lift the pill off the page
// and off the cards it floats over.
function floatingContainerColor(colors: MobileThemeVariables) {
  const screen = colors["--color-screen"];
  const fill = flattenThemeColor(colors["--color-secondary"], screen);
  if (!isDarkThemeColor(screen)) return fill;
  return themeColorWithContrast(
    fill,
    [screen, flattenThemeColor(colors["--color-grouped-card"], screen)],
    1.25,
  );
}

export function workspaceBottomNavigationColors(colors: MobileThemeVariables, floating = false) {
  const screen = colors["--color-screen"];
  const header = flattenThemeColor(colors["--color-header"], screen);
  const foreground = flattenThemeColor(colors["--color-foreground"], header);
  const containerColor = floating
    ? floatingContainerColor(colors)
    : flattenThemeColor(themeColorWithAlpha(foreground, 0.05), header);
  const indicatorColor = themeColorWithContrast(
    flattenThemeColor(themeColorWithAlpha(foreground, 0.22), containerColor),
    containerColor,
    1.5,
  );
  return {
    containerColor,
    indicatorColor,
    selectedColor: themeColorWithContrast(foreground, [indicatorColor, containerColor]),
    unselectedColor: themeColorWithContrast(
      flattenThemeColor(colors["--color-foreground-muted"], containerColor),
      containerColor,
    ),
  };
}

export function androidWorkspaceNavigationColors(
  colors: MobileThemeVariables,
  rail: boolean,
  floating = false,
) {
  if (!rail) return workspaceBottomNavigationColors(colors, floating);
  const containerColor = flattenThemeColor(colors["--color-header"], colors["--color-screen"]);
  const indicatorColor = themeColorWithContrast(
    flattenThemeColor(colors["--color-secondary"], containerColor),
    containerColor,
    1.5,
  );
  return {
    containerColor,
    indicatorColor,
    selectedColor: themeColorWithContrast(
      flattenThemeColor(colors["--color-secondary-foreground"], indicatorColor),
      [indicatorColor, containerColor],
    ),
    unselectedColor: flattenThemeColor(colors["--color-header-foreground"], containerColor),
  };
}

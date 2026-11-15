import { T3_CODE_DARK_THEME_COLORS, type ThemeColors } from "@t3tools/shared/themePalettes";

const canvas = "#121923";
const chrome = "#1c2634";
const surface = "#1d2838";
const secondary = "#26364b";
const raised = "#29374b";
const selection = "#2d3d54";
const text = "#e8eef7";
const mutedText = "#acbbcf";
const border = "#344256";
const accent = "#98bfff";
const onAccent = "#102544";
const danger = "#ff9ba1";

export const GRAPHITE_BLUE_DARK_THEME_COLORS: ThemeColors = {
  ...T3_CODE_DARK_THEME_COLORS,
  canvas,
  chrome,
  toolbar: chrome,
  toolbarForeground: text,
  toolbarBorder: border,
  toolbarControl: surface,
  toolbarControlForeground: text,
  toolbarControlHover: secondary,
  surface,
  surfaceRaised: raised,
  surfaceOverlay: raised,
  text,
  textMuted: mutedText,
  border,
  input: "#63748c",
  focus: accent,
  accent,
  accentForeground: onAccent,
  secondary,
  secondaryForeground: text,
  muted: secondary,
  mutedForeground: mutedText,
  placeholder: mutedText,
  secondaryLabel: mutedText,
  iconMuted: mutedText,
  error: danger,
  errorForeground: danger,
  errorSurface: "#3c252f",
  warningForeground: "#ffd18b",
  warningSurface: "#342b22",
  update: accent,
  updateForeground: accent,
  updateSurface: selection,
  accentSurface: selection,
  accentSurfaceForeground: accent,
  messageSurface: secondary,
  messageForeground: text,
  messageAction: accent,
  messageActionForeground: onAccent,
  messageActionHover: "#b1ceff",
  codeBackground: surface,
  codeForeground: text,
  sidebar: chrome,
  sidebarForeground: text,
  sidebarMutedForeground: mutedText,
  sidebarControlSurface: surface,
  sidebarRowHover: secondary,
  sidebarRowActive: selection,
  sidebarRowSelected: selection,
  sidebarBorder: border,
  terminalBackground: canvas,
  terminalForeground: text,
  terminalCursor: accent,
  terminalSelection: selection,
  terminalScrollbar: border,
  terminalScrollbarHover: "#546780",
};

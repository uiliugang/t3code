import { getResolvedOrResolveTheme, registerCustomTheme, type DiffsTheme } from "@pierre/diffs";

export const JETBRAINS_THEME_NAMES = {
  light: "t3-jetbrains-light",
  dark: "t3-jetbrains-dark",
} as const;

const PALETTES = {
  light: {
    background: "#ffffff",
    foreground: "#1f2329",
    keyword: "#0033b3",
    string: "#067d17",
    number: "#1750eb",
    function: "#00627a",
    field: "#871094",
    comment: "#6f737a",
    activeLine: "#f2f5f9",
  },
  dark: {
    background: "#2b2b2b",
    foreground: "#bababa",
    keyword: "#cc7832",
    string: "#a5c261",
    number: "#6897bb",
    function: "#ffc66d",
    field: "#b695c0",
    comment: "#929292",
    activeLine: "#323232",
  },
} as const;

function syntaxColor(scope: string, palette: (typeof PALETTES)[keyof typeof PALETTES]) {
  if (/^(comment|markup\.quote|markup\.strikethrough|hint|predictive)/u.test(scope))
    return palette.comment;
  if (/^(string|text\.literal|markup\.raw|template_string)/u.test(scope)) return palette.string;
  if (
    /^(keyword(?!\.operator)|preproc|at_keyword|boolean|this|self|variable\.(language|builtin))/u.test(
      scope,
    )
  )
    return palette.keyword;
  if (/^(number|unit|value|plain_value)/u.test(scope)) return palette.number;
  if (/^(function|method_definition)/u.test(scope)) return palette.function;
  if (
    /^(property|shorthand_property|variable\.member|attribute|decorator|constant|variant)/u.test(
      scope,
    )
  )
    return palette.field;
  return palette.foreground;
}

for (const appearance of ["light", "dark"] as const) {
  registerCustomTheme(
    JETBRAINS_THEME_NAMES[appearance],
    async () => {
      const base = await getResolvedOrResolveTheme(`pierre-${appearance}`, "highlights");
      if (!base.zed) throw new Error(`pierre-${appearance} has no Highlights palette`);
      const palette = PALETTES[appearance];
      return {
        ...base.zed,
        name: JETBRAINS_THEME_NAMES[appearance],
        style: {
          ...base.zed.style,
          background: palette.background,
          text: palette.foreground,
          "editor.background": palette.background,
          "editor.foreground": palette.foreground,
          "editor.active_line.background": palette.activeLine,
          syntax: Object.fromEntries(
            Object.entries(base.zed.style.syntax ?? {}).map(([scope, style]) => [
              scope,
              {
                ...(typeof style === "string" ? {} : style),
                color: syntaxColor(scope, palette),
              },
            ]),
          ),
        },
      } satisfies NonNullable<DiffsTheme["zed"]>;
    },
    "zed",
  );
}

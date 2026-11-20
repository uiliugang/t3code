import type { UiLocale } from "@t3tools/shared/uiLocale";
import * as Effect from "effect/Effect";
import { decodeOptions, gtFallback } from "gt-i18n";
import { hashMessage } from "gt-i18n/internal";

type Catalog = Readonly<Record<string, string>>;

const DEFAULT_LOCALE = "en";

// English is the source text and loads nothing. Keep the keys in step with gt.config.json.
const CATALOGS: Readonly<Record<string, () => Promise<{ readonly default: Catalog }>>> = {
  zh: () => import("./translations/zh.json", { with: { type: "json" } }),
};

const loadedCatalogs = new Map<string, Catalog>([[DEFAULT_LOCALE, {}]]);
const listeners = new Set<() => void>();
let activeLocale = DEFAULT_LOCALE;
let activeCatalog: Catalog = {};
let requestedLocale = DEFAULT_LOCALE;

/**
 * Resolves a `msg()` string in the active UI language at call time. Variables are strings so
 * ICU never reformats a number (a PID of 12345 would print "12,345").
 */
export function m(message: string, variables: Readonly<Record<string, string>> = {}): string {
  const decoded = decodeOptions(message);
  const source = typeof decoded?.$_source === "string" ? decoded.$_source : message;
  const options = typeof decoded?.$_source === "string" ? decoded : variables;
  const target =
    activeLocale === DEFAULT_LOCALE
      ? undefined
      : activeCatalog[hashMessage(source, { ...options, $format: "ICU" })];
  // Untranslated text is English, so it takes English plural rules.
  return target === undefined
    ? gtFallback(source, { ...options, $locale: DEFAULT_LOCALE })
    : gtFallback(target, { ...options, $locale: activeLocale, $_fallback: source });
}

/** Runs `listener` after each switch to a different UI language. */
export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const loadCatalog = async (locale: string): Promise<Catalog> => {
  const loaded = loadedCatalogs.get(locale);
  if (loaded) return loaded;
  const catalog = (await CATALOGS[locale]!()).default;
  loadedCatalogs.set(locale, catalog);
  return catalog;
};

export const applyLanguage = Effect.fn("desktop.i18n.applyLanguage")(function* (
  language: UiLocale,
) {
  const locale = language === "zh-CN" ? "zh" : DEFAULT_LOCALE;
  requestedLocale = locale;
  if (locale === activeLocale) return;
  const catalog = yield* Effect.promise(() => loadCatalog(locale));
  // A later call may have asked for another language while this catalog loaded.
  if (requestedLocale !== locale) return;
  activeLocale = locale;
  activeCatalog = catalog;
  for (const listener of listeners) listener();
});

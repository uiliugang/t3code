import "./intl-polyfills";
import { resolveLocale } from "@t3tools/client-runtime/locales";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { GTProvider, initializeGT } from "gt-react-native";
import { useDeferredValue, type ReactNode } from "react";
import { Platform, TurboModuleRegistry, View, type TurboModule } from "react-native";

import { mobilePreferencesAtom } from "../state/preferences";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locales";
import zh from "./translations/zh.json";

// Screens import GT from here so the polyfills above always load first.
export { useGT } from "gt-react-native";

// Committed catalogs, so forks and offline installs never reach GT's CDN. English is the source.
const TRANSLATIONS: Readonly<Record<string, Record<string, string>>> = {
  zh,
};

initializeGT({
  defaultLocale: DEFAULT_LOCALE,
  locales: [...SUPPORTED_LOCALES],
  loadTranslations: async (locale: string) => TRANSLATIONS[locale] ?? {},
});

// Read the device languages from gt-react-native's own native module: GT's getLocale() prefers
// the last locale passed to GTProvider, which it persists, so it can't express "system".
function readSystemLocales(): ReadonlyArray<string> {
  try {
    const locales =
      TurboModuleRegistry.get<{ getNativeLocales(): string[] } & TurboModule>(
        "GtReactNative",
      )?.getNativeLocales() ?? [];
    // On iOS the first entry is NSLocale.currentLocale, whose language is the app's bundle
    // localization (English only), not the user's; preferredLanguages follow it.
    return Platform.OS === "ios" ? locales.slice(1) : locales;
  } catch {
    return [];
  }
}

export function useLanguagePreference(): string {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? preferences.value.uiLanguage === "zh-CN"
      ? "zh"
      : DEFAULT_LOCALE
    : DEFAULT_LOCALE;
}

/** Translates the screens inside it into the saved language; "system" follows the device. */
export function I18nProvider(props: { readonly children: ReactNode }) {
  // GT suspends while a locale's catalog loads. Deferring the switch keeps the current language
  // on screen until then, instead of GT's full-screen spinner.
  const locale = useDeferredValue(
    resolveLocale(useLanguagePreference(), readSystemLocales(), SUPPORTED_LOCALES, DEFAULT_LOCALE),
  );
  return (
    <GTProvider locale={locale} fallback={<View className="flex-1 bg-screen" />}>
      {props.children}
    </GTProvider>
  );
}

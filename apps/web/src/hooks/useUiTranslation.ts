import { translateUi, type UiTranslator } from "@t3tools/shared/uiLocale";
import { useSyncExternalStore } from "react";

type UiLanguage = "en" | "zh-CN";

function readLanguage(): UiLanguage {
  if (typeof document === "undefined") return "en";
  const language = document.documentElement.lang;
  return language === "zh" || language === "zh-CN" ? "zh-CN" : "en";
}

// Client settings write `document.lang` whenever the language changes. Reading it here keeps
// this hook out of the settings/state import cycle while still re-rendering on a switch.
function subscribeToLanguage(listener: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  return () => observer.disconnect();
}

export function useUiTranslation(): UiTranslator {
  const language = useSyncExternalStore<UiLanguage>(subscribeToLanguage, readLanguage, () => "en");
  return (message, values) => translateUi(language, message, values);
}

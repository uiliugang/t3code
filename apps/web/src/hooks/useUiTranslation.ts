import { translateUi } from "@t3tools/shared/uiLocale";
import { useClientSettings } from "./useSettings";

export function useUiTranslation() {
  const language = useClientSettings((settings) => settings.uiLanguage);
  return (message: string) => translateUi(language, message);
}

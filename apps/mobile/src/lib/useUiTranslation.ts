import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { translateUi } from "@t3tools/shared/uiLocale";
import { useCallback } from "react";
import { mobilePreferencesAtom } from "../state/preferences";

export function useUiTranslation() {
  const result = useAtomValue(mobilePreferencesAtom);
  const language = AsyncResult.isSuccess(result) ? (result.value.uiLanguage ?? "en") : "en";
  return useCallback(
    (message: string, values?: Parameters<typeof translateUi>[2]) =>
      translateUi(language, message, values),
    [language],
  );
}

import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { translateUi } from "@t3tools/shared/uiLocale";
import { mobilePreferencesAtom } from "../state/preferences";

export function useUiTranslation() {
  const result = useAtomValue(mobilePreferencesAtom);
  const language = AsyncResult.isSuccess(result) ? (result.value.uiLanguage ?? "en") : "en";
  return (message: string) => translateUi(language, message);
}

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { UI_LANGUAGES } from "@t3tools/shared/uiLocale";
import { ListSection } from "../../../../components/ui/ListSection";
import { ListRow } from "../../../../components/ui/ListRow";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../../state/preferences";
import { useUiTranslation } from "../../../../lib/useUiTranslation";

export function LanguageSection() {
  const t = useUiTranslation();
  const result = useAtomValue(mobilePreferencesAtom);
  const update = useAtomSet(updateMobilePreferencesAtom);
  const language = AsyncResult.isSuccess(result) ? (result.value.uiLanguage ?? "en") : "en";
  return (
    <ListSection title={t("Language")} footer={t("Choose the language for this device.")}>
      {UI_LANGUAGES.map((option) => (
        <ListRow
          key={option.value}
          label={option.label}
          detail={language === option.value ? "✓" : undefined}
          onPress={() => update({ uiLanguage: option.value })}
        />
      ))}
    </ListSection>
  );
}

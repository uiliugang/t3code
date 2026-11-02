import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { mobilePreferencesAtom } from "../state/preferences";

export function useProjectPresentation() {
  const result = useAtomValue(mobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(result) ? result.value : {};
  return {
    showRepositoryIcons:
      preferences.showRepositoryIcons ?? DEFAULT_CLIENT_SETTINGS.showRepositoryIcons,
    showGroupIcons: preferences.showGroupIcons ?? DEFAULT_CLIENT_SETTINGS.showGroupIcons,
    capitalizeProjectNames:
      preferences.capitalizeProjectNames ?? DEFAULT_CLIENT_SETTINGS.capitalizeProjectNames,
  };
}

import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import { translateUi } from "@t3tools/shared/uiLocale";

export function offHeadPullRequestCheckoutToast(
  terminology: ChangeRequestTerminology,
  t = translateUi.bind(null, "en"),
) {
  return {
    type: "warning",
    title: t("Checked out, but not confirmed on the latest commit"),
    description: t(
      "This checkout could not be confirmed at the {term}'s latest commit, so its code may differ. Local commits or uncommitted work keep a checkout where it is.",
      { term: t(terminology.singular) },
    ),
  } as const;
}

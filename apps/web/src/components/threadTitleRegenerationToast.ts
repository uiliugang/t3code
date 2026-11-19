import { translateUi, type UiTranslator } from "@t3tools/shared/uiLocale";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { ThreadTitleRegenerationOutcome } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { msg } from "gt-react";

import { m } from "../i18n/messages";
import { stackedThreadToast } from "./ui/toast";

type TitleRegenerationResult = AtomCommandResult<ThreadTitleRegenerationOutcome | null, unknown>;

function failureMessage(result: TitleRegenerationResult): string | null {
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) return null;
    const error = squashAtomCommandFailure(result);
    return thrownErrorMessage(error, m) ?? m(msg("An error occurred."));
  }
  return result.value?.status === "failed"
    ? (result.value.message ?? m(msg("Title generation failed.")))
    : null;
}

function isKept(result: TitleRegenerationResult): boolean {
  return result._tag === "Success" && result.value?.status === "unchanged";
}

export function titleRegenerationToast(
  results: ReadonlyArray<TitleRegenerationResult>,
  t: UiTranslator = translateUi.bind(null, "en"),
) {
  const failures = results.flatMap((result) => {
    const message = failureMessage(result);
    return message === null ? [] : [message];
  });
  if (failures.length > 0) {
    return stackedThreadToast({
      type: "error",
      title:
        results.length === 1
          ? m(msg("Failed to regenerate thread title"))
          : m(
              msg(
                "{total, plural, one {Failed to regenerate {failed} of {total} thread titles} other {Failed to regenerate {failed} of {total} thread titles}}",
                {
                  failed: failures.length,
                  total: results.length,
                },
              ),
            ),
      description: failures[0],
    });
  }
  const kept = results.filter(isKept).length;
  if (kept === 0) return null;
  if (results.length === 1) {
    return stackedThreadToast({
      type: "info",
      title: t("Title kept"),
      description: t("The current title already fits this thread."),
    });
  }
  return stackedThreadToast({
    type: "info",
    title:
      kept === results.length
        ? t("Titles kept")
        : t("Kept {count} of {total} titles", { count: kept, total: results.length }),
    description:
      kept === results.length
        ? t("The current titles already fit these threads.")
        : t("Those titles already fit their threads."),
  });
}

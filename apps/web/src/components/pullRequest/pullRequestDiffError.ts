import { translateUi } from "@t3tools/shared/uiLocale";

/** Diff failures currently include transport wrappers, so recognize the reason inside them. */
export function describePullRequestDiffError(
  error: string,
  providerName: string,
  term: string,
  t = translateUi.bind(null, "en"),
) {
  if (/\brate limit\b|\brate[-_]limited\b|\btoo many requests\b/i.test(error)) {
    return {
      title: t("{host} rate limit reached", { host: providerName }),
      description: t(
        "{host} is temporarily limiting requests, so this diff couldn't be loaded. Try again after the limit resets, or view the changes on {host}.",
        { host: providerName },
      ),
    };
  }

  return {
    title: t("Couldn't load the changes"),
    description: t(
      "The environment couldn't load this {term}'s diff. Try again, or view the changes on {host}.",
      { term: t(term), host: providerName },
    ),
  };
}

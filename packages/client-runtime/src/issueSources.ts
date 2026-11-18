import type { IssueSource } from "@t3tools/contracts";

export function mergeProjectIssueSources(
  automatic: readonly IssueSource[],
  saved: readonly IssueSource[],
) {
  const overridden = new Set(saved.map((entry) => entry.provider));
  return [...automatic.filter((entry) => !overridden.has(entry.provider)), ...saved];
}

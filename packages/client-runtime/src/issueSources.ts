import type { IssueSource, ProjectId } from "@t3tools/contracts";
import * as Array from "effect/Array";

export const issueSourceProjectIdBatches = (projectIds: readonly ProjectId[]) =>
  Array.chunksOf(projectIds, 500);

export function mergeProjectIssueSources(
  automatic: readonly IssueSource[],
  saved: readonly IssueSource[],
) {
  const overridden = new Set(saved.map((entry) => entry.provider));
  return [...automatic.filter((entry) => !overridden.has(entry.provider)), ...saved];
}

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

export function parseMepSpaceIds(text: string): string[] | null {
  const ids = [
    ...new Set(
      text
        .split(/[,，]/u)
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  return ids.length && ids.every((id) => /^[1-9]\d{0,199}$/u.test(id)) ? ids : null;
}

export function withMepSpaceOverrides(
  saved: readonly IssueSource[],
  ids: readonly string[],
): IssueSource[] {
  return [
    ...saved.filter((source) => source.provider !== "meituan"),
    ...ids.map((scope) => ({ provider: "meituan" as const, host: "mep.sankuai.com", scope })),
  ];
}

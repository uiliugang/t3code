import {
  issueSourcesMatch,
  type IssueProvider,
  type IssueSource,
  type ProjectId,
} from "@t3tools/contracts";
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

export function projectIssueSourceEdit(
  projectId: ProjectId,
  provider: IssueProvider,
  current: readonly IssueSource[],
  expected: readonly IssueSource[],
  edit: (saved: readonly IssueSource[]) => readonly IssueSource[],
) {
  if (!issueSourcesMatch(current, expected, provider)) return null;
  return {
    issueSourceProvider: provider,
    expectedIssueProjectSources: { [projectId]: expected },
    patch: { issueProjectSources: { [projectId]: edit(current) } },
  };
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

export function withGithubRepositoryOverride(
  saved: readonly IssueSource[],
  current: IssueSource | undefined,
  scope: string | null,
): IssueSource[] {
  const host = current?.host ?? "github.com";
  const matches = (source: IssueSource, repository: string | undefined) =>
    source.provider === "github" && source.host === host && source.scope === repository;
  const index = saved.findIndex((source) => matches(source, current?.scope));
  const next =
    scope && !saved.some((source, i) => i !== index && matches(source, scope))
      ? [{ provider: "github" as const, host, scope }]
      : [];
  return index === -1
    ? [...saved, ...next]
    : saved.flatMap((source, i) => (i === index ? next : [source]));
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

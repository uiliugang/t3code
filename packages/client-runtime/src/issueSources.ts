import {
  issueSourcesMatch,
  type IssueProvider,
  type IssueSource,
  type ProjectId,
} from "@t3tools/contracts";
import * as Array from "effect/Array";

export const issueSourceProjectIdBatches = (projectIds: readonly ProjectId[]) =>
  Array.chunksOf(projectIds, 500);

export function projectIssueSourceEdit(
  projectId: ProjectId,
  provider: IssueProvider,
  current: readonly IssueSource[],
  expected: readonly IssueSource[],
  edit: (saved: readonly IssueSource[]) => readonly IssueSource[],
) {
  if (!issueSourcesMatch(current, expected)) return null;
  return {
    issueSourceProvider: provider,
    expectedIssueProjectSources: { [projectId]: expected },
    patch: {
      issueProjectSources: {
        [projectId]: edit(current),
      },
    },
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
  sources: readonly IssueSource[],
  current: IssueSource | undefined,
  scope: string | null,
): IssueSource[] {
  const saved = sources.filter((source) => source.provider === "github");
  const host = current?.host ?? "github.com";
  const matches = (source: IssueSource, repository: string | undefined) =>
    source.host === host && source.scope === repository;
  const index = saved.findIndex((source) => matches(source, current?.scope));
  const next =
    scope && !saved.some((source, i) => i !== index && matches(source, scope))
      ? [{ provider: "github" as const, host, scope }]
      : [];
  return index === -1
    ? [...saved, ...next]
    : saved.flatMap((source, i) => (i === index ? next : [source]));
}

export function withMepSpaceOverrides(ids: readonly string[]): IssueSource[] {
  return ids.map((scope) => ({ provider: "meituan", host: "mep.sankuai.com", scope }));
}

import {
  issueSourcesMatch,
  mergeProjectIssueSources,
  repositoryIssueKind,
  type RepositoryIdentity,
  RequirementIssueError,
  type IssueProvider,
  type IssueSource,
  type ProjectId,
} from "@t3tools/contracts";
import * as Array from "effect/Array";

export const issueSourceProjectIdBatches = (projectIds: readonly ProjectId[]) =>
  Array.chunksOf(projectIds, 500);

export function detectedProjectIssueKind(
  identity: RepositoryIdentity | null | undefined,
  result?: { readonly provider?: IssueProvider; readonly sources: readonly IssueSource[] },
) {
  if (result?.provider) return result.provider;
  const first = result?.sources[0]?.provider;
  if (first && result?.sources.every((source) => source.provider === first)) return first;
  if (
    identity?.issueRepository === undefined &&
    identity?.origin &&
    identity.canonicalKey.split("/", 1)[0] !== identity.origin.canonicalKey.split("/", 1)[0]
  )
    return undefined;
  return repositoryIssueKind(identity);
}

const legacyRepositoryError = new RequirementIssueError({
  operation: "repository",
  reason: "unavailable",
}).message;

export function canBindUndetectedProject(
  singleProvider: boolean,
  discovery: "pending" | "failed" | "ready",
  error?: string,
) {
  return (
    discovery === "ready" ||
    (!singleProvider && discovery === "failed" && error === legacyRepositoryError)
  );
}

export function listedProjectIssueSources(
  singleProvider: boolean,
  automatic: readonly IssueSource[],
  saved: readonly IssueSource[],
  repositoryKind?: string,
) {
  if (singleProvider) return mergeProjectIssueSources(automatic, saved, repositoryKind);
  const overridden = new Set(saved.map((source) => source.provider));
  return [...automatic.filter((source) => !overridden.has(source.provider)), ...saved];
}

export function projectIssueSourceEdit(
  projectId: ProjectId,
  provider: IssueProvider | undefined,
  current: readonly IssueSource[],
  expected: readonly IssueSource[],
  edit: (saved: readonly IssueSource[]) => readonly IssueSource[],
) {
  if (!issueSourcesMatch(current, expected)) return null;
  return {
    ...(provider ? { issueSourceProvider: provider } : {}),
    expectedIssueProjectSources: { [projectId]: expected },
    patch: {
      issueProjectSources: {
        [projectId]: edit(current),
      },
    },
  };
}

export function projectIssueSourceCleanup(
  singleProvider: boolean,
  projectId: ProjectId,
  provider: IssueProvider | undefined,
  saved: readonly IssueSource[],
  mepEnabled: boolean,
) {
  if (!provider) return null;
  const disabledMep =
    !mepEnabled && provider === "meituan" && saved.some((s) => s.provider === provider);
  if (singleProvider && !disabledMep) return null;
  const remove = (source: IssueSource) =>
    disabledMep ? singleProvider || source.provider === "meituan" : source.provider !== provider;
  const removed = saved.filter(remove);
  if (!removed.length) return null;
  return {
    disabledMep,
    scopes: removed.map((source) => `${source.host}/${source.scope}`).join(", "),
    input: {
      expectedIssueProjectSources: { [projectId]: saved },
      patch: {
        issueProjectSources: {
          [projectId]: saved.filter((source) => !remove(source)),
        },
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

import {
  sourceControlTokenHost,
  type EnvironmentId,
  type ProjectId,
  type PullRequestRef,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import type {
  ChangeRequestLink,
  ParsedChangeRequestUrl,
} from "@t3tools/source-control-core/shared/definition";
import { parseUrl } from "@t3tools/shared/url";

import { sourceControlClients } from "./sourceControlClients.ts";

export function changeRequestWebTarget(
  reference: Pick<PullRequestRef, "host" | "repository" | "number">,
  url: string | undefined,
): PullRequestRef["target"] {
  if (url === undefined) return undefined;
  const parsed = sourceControlClients.parseChangeRequestUrl(url);
  if (parsed === null) return undefined;
  const origin = parsed.link.rpcOrigin ?? parseUrl(parsed.link.repositoryUrl)?.origin;
  const host = parsed.link.authority ?? parsed.link.host;
  return origin !== undefined &&
    (reference.host === undefined ||
      parseUrl(`${parseUrl(origin)?.protocol}//${reference.host}`)?.host === host) &&
    parsed.link.repository.toLowerCase() === reference.repository.toLowerCase() &&
    parsed.link.number === reference.number
    ? { provider: parsed.definition.kind, origin }
    : undefined;
}

interface ChangeRequestProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

type ProjectChangeRequestLink = ChangeRequestLink &
  Partial<Pick<ParsedChangeRequestUrl, "repositoryUrl">>;

type SupportsWebTargets = (environmentId: EnvironmentId) => boolean;

function findChangeRequestProject<Project extends ChangeRequestProject>(
  projects: ReadonlyArray<Project>,
  link: ProjectChangeRequestLink,
  provider: string,
  match: "isChangeRequestInRepository" | "canReadChangeRequestOnHost",
  supportsWebTargets?: SupportsWebTargets,
): Project | undefined {
  const origin =
    provider === "gitlab" && link.repositoryUrl !== undefined
      ? parseUrl(link.repositoryUrl)?.origin
      : undefined;
  let inferred: Project | undefined;
  for (const project of projects) {
    const identity = project.repositoryIdentity;
    if (identity?.provider !== provider) continue;
    if (!sourceControlClients.get(identity.provider)[match](identity, link)) continue;
    if (origin === undefined) return project;
    const remote = parseUrl(identity.locator.remoteUrl);
    if (remote?.protocol === "http:" || remote?.protocol === "https:") {
      if (remote.origin === origin) return project;
    } else if (supportsWebTargets?.(project.environmentId)) {
      inferred ??= project;
    }
  }
  return inferred;
}

/** The project whose own repository holds the change request, not just one on its host. */
export function findProjectForChangeRequest<Project extends ChangeRequestProject>(
  projects: ReadonlyArray<Project>,
  link: ProjectChangeRequestLink,
  provider: string,
  supportsWebTargets?: SupportsWebTargets,
): Project | undefined {
  return findChangeRequestProject(
    projects,
    link,
    provider,
    "isChangeRequestInRepository",
    supportsWebTargets,
  );
}

/** Prefers the project checked out from the link's repository, else lends any project on its host. */
export function findProjectOnChangeRequestHost<Project extends ChangeRequestProject>(
  projects: ReadonlyArray<Project>,
  link: ProjectChangeRequestLink,
  provider: string,
  supportsWebTargets?: SupportsWebTargets,
): Project | undefined {
  return (
    findProjectForChangeRequest(projects, link, provider) ??
    findChangeRequestProject(projects, link, provider, "canReadChangeRequestOnHost") ??
    (supportsWebTargets === undefined
      ? undefined
      : (findProjectForChangeRequest(projects, link, provider, supportsWebTargets) ??
        findChangeRequestProject(
          projects,
          link,
          provider,
          "canReadChangeRequestOnHost",
          supportsWebTargets,
        )))
  );
}

/**
 * Where every client opens a change request link in the app, or null for the browser. A link
 * opened into a pull request view may borrow any project on its host, so a mirror's or a
 * sibling repository's link still opens in the app.
 */
export function resolveChangeRequestLinkTarget<Project extends ChangeRequestProject>({
  url,
  projects,
  configLoaded,
  environmentId,
  projectId,
  primaryEnvironmentId,
  lendHostProject,
  supportsWebTargets,
}: {
  url: string;
  projects: ReadonlyArray<Project>;
  configLoaded: (environmentId: EnvironmentId) => boolean;
  /** The link's own environment; without one, any environment that reads change requests. */
  environmentId?: EnvironmentId | undefined;
  /** The project the link came from, tried first. */
  projectId?: ProjectId | undefined;
  primaryEnvironmentId?: EnvironmentId | null | undefined;
  lendHostProject: boolean;
  supportsWebTargets?: SupportsWebTargets | undefined;
}): {
  readonly project: Project;
  readonly repository: string;
  readonly number: number;
  readonly host?: string;
} | null {
  const parsed = sourceControlClients.parseChangeRequestUrl(url);
  if (parsed === null) return null;
  const { definition, link } = parsed;
  // Matching remotes do not make project ids usable outside the link's environment.
  const candidates = (
    environmentId === undefined
      ? projects.filter((project) => configLoaded(project.environmentId))
      : projects.filter((project) => project.environmentId === environmentId)
  ).sort(
    (left, right) =>
      Number(right.id === projectId) - Number(left.id === projectId) ||
      Number(right.environmentId === primaryEnvironmentId) -
        Number(left.environmentId === primaryEnvironmentId),
  );
  const project = lendHostProject
    ? findProjectOnChangeRequestHost(candidates, link, definition.kind, supportsWebTargets)
    : findProjectForChangeRequest(candidates, link, definition.kind, supportsWebTargets);
  if (project === undefined || !configLoaded(project.environmentId)) return null;
  return {
    project,
    repository: link.repository,
    number: link.number,
    host: link.authority ?? link.host,
  };
}

export function resolvePullRequestPreviewTarget({
  environmentId,
  projects,
  pullRequestsEnabled,
  supportsWebTargets,
  url,
}: {
  environmentId: EnvironmentId | null;
  projects: ReadonlyArray<ChangeRequestProject>;
  pullRequestsEnabled: boolean;
  supportsWebTargets?: boolean;
  url: string;
}): { environmentId: EnvironmentId; input: PullRequestRef } | null {
  if (!pullRequestsEnabled || environmentId === null) return null;
  const parsed = sourceControlClients.parseChangeRequestUrl(url);
  if (parsed === null) return null;
  const { definition, link } = parsed;
  const project = findProjectForChangeRequest(
    projects.filter((candidate) => candidate.environmentId === environmentId),
    link,
    definition.kind,
    supportsWebTargets ? () => true : undefined,
  );
  if (project === undefined) return null;
  const host = link.authority ?? link.host;
  const target = changeRequestWebTarget(
    { host, repository: link.repository, number: link.number },
    url,
  );
  if (target === undefined) return null;
  return {
    environmentId,
    input: {
      projectId: project.id,
      host,
      target,
      repository:
        sourceControlClients.repositorySelector(project.repositoryIdentity) ?? link.repository,
      number: link.number,
    },
  };
}

/** The project host's browser URL for one of its change requests, before its detail loads. */
export function projectChangeRequestUrl(
  identity: RepositoryIdentity | null | undefined,
  repository: string,
  number: number,
): string | null {
  if (identity?.provider === undefined) return null;
  const [host, ...path] = identity.canonicalKey.split("/");
  if (!host) return null;
  const ownRepository = sourceControlClients.repositorySelector(identity) === repository;
  return sourceControlClients.get(identity.provider).changeRequestUrl({
    host,
    repository: ownRepository ? path.join("/") : repository,
    number,
    remoteUrl: identity.locator.remoteUrl.trim(),
    ...(ownRepository && identity.webUrl !== undefined ? { webUrl: identity.webUrl } : {}),
  });
}

export function changeRequestFallback(
  reference: Pick<PullRequestRef, "host" | "repository" | "number" | "target">,
  identity: RepositoryIdentity | null | undefined,
  sourceUrl?: string,
) {
  const projectUrl = projectChangeRequestUrl(identity, reference.repository, reference.number);
  const projectLink = sourceControlClients.parseChangeRequestUrl(projectUrl ?? "");
  const url = sourceUrl ?? projectUrl;
  if (url === null) return null;
  const parsed = sourceControlClients.parseChangeRequestUrl(url);
  if (parsed === null) return null;
  if (reference.target !== undefined) {
    const target = changeRequestWebTarget(reference, url);
    return target?.provider === reference.target.provider &&
      target.origin === reference.target.origin
      ? { url, definition: parsed.definition }
      : null;
  }
  const host = parsed.link.authority ?? parsed.link.host;
  const projectHost = projectLink?.link.authority ?? projectLink?.link.host;
  const expectedHost = reference.host ?? projectHost;
  if (
    expectedHost === undefined ||
    host !== sourceControlTokenHost(parsed.definition.kind, expectedHost) ||
    parsed.link.repository.toLowerCase() !== reference.repository.toLowerCase() ||
    parsed.link.number !== reference.number
  )
    return null;
  const projectProtocol =
    projectLink?.definition.kind === parsed.definition.kind && projectHost === host
      ? parseUrl(projectLink.link.repositoryUrl)?.protocol
      : undefined;
  if (parseUrl(url)?.protocol !== (projectProtocol ?? "https:")) return null;
  return { url, definition: parsed.definition };
}

export function projectCommitUrl(
  identity: RepositoryIdentity | null | undefined,
  sha: string,
): string | null {
  if (identity?.provider === undefined) return null;
  const [host, ...path] = identity.canonicalKey.split("/");
  if (!host) return null;
  return (
    sourceControlClients.get(identity.provider).commitUrl?.({
      host,
      repository: path.join("/"),
      sha,
      remoteUrl: identity.locator.remoteUrl.trim(),
      ...(identity.webUrl !== undefined ? { webUrl: identity.webUrl } : {}),
    }) ?? null
  );
}

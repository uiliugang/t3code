import {
  sourceControlTokenHost,
  type EnvironmentId,
  type ProjectId,
  type PullRequestRef,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import {
  remoteWebOrigin,
  type ChangeRequestLink,
  type ParsedChangeRequestUrl,
} from "@t3tools/source-control-core/shared/definition";
import { parseUrl } from "@t3tools/shared/url";

import { sourceControlClients } from "./sourceControlClients.ts";

interface ChangeRequestProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

type ProjectChangeRequestLink = ChangeRequestLink &
  Partial<Pick<ParsedChangeRequestUrl, "repositoryUrl">>;

function matchesChangeRequestProtocol(
  identity: RepositoryIdentity,
  link: ProjectChangeRequestLink,
): boolean {
  if (identity.provider !== "gitlab" || link.repositoryUrl === undefined) return true;
  const origin = remoteWebOrigin(link.authority ?? link.host, identity.locator.remoteUrl);
  return parseUrl(link.repositoryUrl)?.origin === origin;
}

/** The project whose own repository holds the change request, not just one on its host. */
export function findProjectForChangeRequest<Project extends ChangeRequestProject>(
  projects: ReadonlyArray<Project>,
  link: ProjectChangeRequestLink,
  provider: string,
): Project | undefined {
  return projects.find((project) => {
    const identity = project.repositoryIdentity;
    return (
      identity?.provider === provider &&
      matchesChangeRequestProtocol(identity, link) &&
      sourceControlClients.get(identity.provider).isChangeRequestInRepository(identity, link)
    );
  });
}

/** Prefers the project checked out from the link's repository, else lends any project on its host. */
export function findProjectOnChangeRequestHost<Project extends ChangeRequestProject>(
  projects: ReadonlyArray<Project>,
  link: ProjectChangeRequestLink,
  provider: string,
): Project | undefined {
  return (
    findProjectForChangeRequest(projects, link, provider) ??
    projects.find((project) => {
      const identity = project.repositoryIdentity;
      return (
        identity?.provider === provider &&
        matchesChangeRequestProtocol(identity, link) &&
        sourceControlClients.get(identity.provider).canReadChangeRequestOnHost(identity, link)
      );
    })
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
  const project =
    findProjectForChangeRequest(candidates, link, definition.kind) ??
    (lendHostProject
      ? findProjectOnChangeRequestHost(candidates, link, definition.kind)
      : undefined);
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
  url,
}: {
  environmentId: EnvironmentId | null;
  projects: ReadonlyArray<ChangeRequestProject>;
  pullRequestsEnabled: boolean;
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
  );
  if (project === undefined) return null;
  return {
    environmentId,
    input: {
      projectId: project.id,
      host: link.authority ?? link.host,
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
  reference: Pick<PullRequestRef, "host" | "repository" | "number">,
  identity: RepositoryIdentity | null | undefined,
  sourceUrl?: string,
) {
  const projectUrl = projectChangeRequestUrl(identity, reference.repository, reference.number);
  const projectLink = sourceControlClients.parseChangeRequestUrl(projectUrl ?? "");
  const url = sourceUrl ?? projectUrl;
  if (url === null) return null;
  const parsed = sourceControlClients.parseChangeRequestUrl(url);
  if (parsed === null) return null;
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

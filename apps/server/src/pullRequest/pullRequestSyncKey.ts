import {
  ProjectId,
  type PullRequestRef,
  type RepositoryIdentity,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { normalizeThreadPullRequestKey } from "../sourceControl/threadPullRequests.ts";

export function pullRequestSyncKey(
  reference: PullRequestRef,
  identity?: RepositoryIdentity | null,
): ThreadPullRequestKey | null {
  const host = identity
    ? sourceControlDefinitions.changeRequestHost(identity, identity.provider)
    : undefined;
  const resolvedHost = reference.host ?? host;
  return resolvedHost === undefined
    ? null
    : normalizeThreadPullRequestKey({
        host: resolvedHost,
        target: reference.target,
        repository: reference.repository,
        number: reference.number,
      });
}

/**
 * The repositories whose pull requests are the project's own, each with the remote to fetch it
 * from: its primary one, then the fork its `origin` remote names when that is on the same host.
 */
export function ownPullRequestRepositories(
  identity: RepositoryIdentity | null | undefined,
): ReadonlyArray<{
  readonly key: Pick<ThreadPullRequestKey, "host" | "repository">;
  readonly locator: RepositoryIdentity["locator"];
}> {
  if (!identity) return [];
  const candidates: Array<RepositoryIdentity> = [identity];
  const origin = identity.origin;
  const [host, ...path] = origin?.canonicalKey.split("/") ?? [];
  if (
    origin?.remoteUrl !== undefined &&
    path.length > 0 &&
    host === identity.canonicalKey.split("/")[0]
  ) {
    const { owner: _owner, name: _name, ...primary } = identity;
    candidates.push({
      ...primary,
      canonicalKey: origin.canonicalKey,
      displayName: origin.displayName ?? path.join("/"),
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: origin.remoteUrl },
    });
  }
  return candidates.flatMap((candidate) => {
    const key = pullRequestSyncKey(
      {
        projectId: ProjectId.make("own"),
        repository: sourceControlDefinitions.repositorySelector(candidate) ?? "",
        number: 1,
      },
      candidate,
    );
    return key === null
      ? []
      : [{ key: { host: key.host, repository: key.repository }, locator: candidate.locator }];
  });
}

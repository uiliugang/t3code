import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControl,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  parseChangeRequestPath,
  projectChangeRequestHost,
} from "@t3tools/source-control-core/shared/definition";

const KIND = SourceControlProviderKind.make("meituan");
const HOST = "git.sankuai.com";
const WEB_HOST = "dev.sankuai.com";
const REPOSITORY = /^[a-zA-Z0-9._~-]+\/[a-zA-Z0-9._-]+$/u;

function repositoryKey(key: string): string | null {
  const match = /^git\.sankuai\.com\/(?:scm\/)?([^/]+\/[^/]+)$/u.exec(key.toLowerCase());
  return match?.[1] && REPOSITORY.test(match[1]) ? `${HOST}/${match[1]}` : null;
}

export function parsePullRequestUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.port || url.username || url.password) return null;
  const route =
    url.hostname === WEB_HOST
      ? /^\/code\/repo-detail\/([^/]+\/[^/]+)\/pr\/(\d+)(?:\/|$)/u
      : url.hostname === HOST
        ? /^\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)(?:\/|$)/u
        : null;
  if (!route) return null;
  if (url.hostname === HOST) {
    const match = route.exec(url.pathname);
    if (!match) return null;
    url.pathname = `/${match[1]}/${match[2]}/pull/${match[3]}`;
  }
  const link = parseChangeRequestPath(
    url,
    url.hostname === HOST ? /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/u : route,
  );
  return link && REPOSITORY.test(link.repository)
    ? {
        ...link,
        host: HOST,
        repositoryUrl: `https://${WEB_HOST}/code/repo-detail/${link.repository}`,
      }
    : null;
}

export const definition = defineSourceControl({
  kind: KIND,
  label: "Meituan Code",
  pickerLabel: "Meituan Code",
  icon: {
    viewBox: "0 0 24 24",
    paths: [
      { d: "M3 4h18v16H3z", fill: "#FFC300" },
      { d: "M7 16V8l5 5 5-5v8", stroke: "#222222", strokeWidth: 2 },
    ],
  },
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "project/repository",
  publicHost: HOST,
  publishDescription: "Meituan Code",
  publishHost: () => HOST,
  newRepositoryOwner: () => null,
  defaultCloneTransport: "ssh",
  repositoryKeyFromRemote: repositoryKey,
  canonicalRepositoryKey: repositoryKey,
  changeRequestUrl: ({ repository, number }) =>
    `https://${WEB_HOST}/code/repo-detail/${repository}/pr/${number}/overview`,
  parseChangeRequestUrl: (url) => parsePullRequestUrl(url.href),
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set(["ready", "close", "reopen", "merge"] as const),
  checkoutCommand: () => null,
  changeRequestCloseCommand: /\bcode-cli\s+pr\s+(?:merge|close)\b/u,
  authorProfileUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: (url) => parsePullRequestUrl(url) !== null,
  checkoutChangeRequestHost: () => null,
  recognizeRemote: ({ hostname }) =>
    hostname === HOST ? { kind: KIND, name: "Meituan Code", baseUrl: `https://${HOST}` } : null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(projectChangeRequestHost(identity, KIND), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
});

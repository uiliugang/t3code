import type { NavigationState } from "@react-navigation/native";
import { changeRequestWebTarget } from "@t3tools/client-runtime/change-request-links";
import { pullRequestListKey } from "./pullRequestList";
import type { PullRequestParams } from "./usePullRequestDiff";

export function pullRequestParamsWebTarget(params: PullRequestParams) {
  const summary = params.initialSummary;
  return (
    changeRequestWebTarget(params, params.navigationUrl) ??
    (summary && "target" in summary ? summary.target : undefined) ??
    changeRequestWebTarget(params, summary?.url)
  );
}

export function pullRequestNavigationUrl(params: object | undefined): string | undefined {
  if (!params) return undefined;
  if ("navigationUrl" in params && typeof params.navigationUrl === "string") {
    return params.navigationUrl;
  }
  const summary = "initialSummary" in params ? params.initialSummary : undefined;
  return typeof summary === "object" &&
    summary !== null &&
    "url" in summary &&
    typeof summary.url === "string"
    ? summary.url
    : undefined;
}

export function selectedPullRequestKeyOf(params: object | undefined): string | null {
  if (
    !params ||
    !("environmentId" in params) ||
    typeof params.environmentId !== "string" ||
    !("repository" in params) ||
    typeof params.repository !== "string" ||
    !("number" in params) ||
    typeof params.number !== "number"
  )
    return null;
  const host = "host" in params && typeof params.host === "string" ? params.host : undefined;
  const { environmentId, repository, number } = params;
  const target = changeRequestWebTarget(
    { host, repository, number },
    pullRequestNavigationUrl(params),
  );
  return host === undefined && target === undefined
    ? null
    : `${environmentId}:${pullRequestListKey({ host: host ?? "", repository, number, target })}`;
}

export function selectedPullRequestKey(state: Pick<NavigationState, "routes" | "index">) {
  for (let index = state.index; index >= 0; index--) {
    const route = state.routes[index];
    if (!route) continue;
    if (route.name === "Home" || route.name.startsWith("Thread")) return null;
    if (!route.name.startsWith("PullRequest")) continue;
    const key = selectedPullRequestKeyOf(route.params);
    if (key !== null) return key;
    if (route.name === "PullRequest") return null;
  }
  return null;
}

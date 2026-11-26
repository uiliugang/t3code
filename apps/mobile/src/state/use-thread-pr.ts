import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { changeRequestWebTarget } from "@t3tools/client-runtime/change-request-links";
import { legacyThreadPullRequestKey } from "@t3tools/client-runtime/thread-pull-requests";
import {
  createLinkedPullRequestSummaryAtomFamily,
  pullRequestDetailToVcsStatus,
} from "@t3tools/client-runtime/state/pull-requests";
import { EnvironmentId, type PullRequestRef, type PullRequestSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import { useMessages } from "gt-react-native";
import { use, useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";
import { useEnvironmentQuery } from "./query";
import { ThreadPrDemandContext } from "./thread-pr-demand";
import {
  knownPullRequestSummary,
  rememberBounded,
  resolveThreadPrSource,
  presentThreadPr,
  type ThreadPrPresentation,
} from "./thread-pr-presentation";

const MAX_PULL_REQUEST_SNAPSHOTS = 500;

// One bounded cache survives row virtualization (the summary query is dropped once idle) without
// retaining one live atom for every pull request ever seen.
const pullRequestSnapshotsAtom = Atom.make<
  ReadonlyMap<
    string,
    {
      readonly environmentId: EnvironmentId;
      readonly summary: PullRequestSummary;
    }
  >
>(new Map()).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-pr-snapshots"));

function snapshotKey(environmentId: EnvironmentId, reference: PullRequestRef): string {
  return JSON.stringify([
    environmentId,
    reference.projectId,
    reference.repository,
    reference.number,
    reference.host,
    reference.target?.provider,
    reference.target?.origin,
  ]);
}

const pullRequestSummaryAtom = createLinkedPullRequestSummaryAtomFamily(
  connectionAtomRuntime,
  undefined,
  ({ environmentId, input }, summary, registry) =>
    Effect.sync(() =>
      registry.update(pullRequestSnapshotsAtom, (current) =>
        rememberBounded(
          current,
          snapshotKey(environmentId, input),
          { environmentId, summary },
          MAX_PULL_REQUEST_SNAPSHOTS,
        ),
      ),
    ),
);

export { type ThreadPr, type ThreadPrPresentation } from "./thread-pr-presentation";

/** Seeds a pull request page with a summary already in memory, never another pull request's. */
export function withKnownPullRequestSummary<
  Params extends {
    readonly environmentId: string;
    readonly host?: string;
    readonly repository: string;
    readonly number: number;
    readonly navigationUrl?: string;
    readonly target?: PullRequestRef["target"];
  },
>(params: Params) {
  const environmentId = EnvironmentId.make(params.environmentId);
  const url = params.navigationUrl;
  const target = params.target ?? changeRequestWebTarget(params, url);
  const initialSummary =
    target === undefined || url === undefined
      ? undefined
      : knownPullRequestSummary(
          { ...legacyThreadPullRequestKey({ ...params, url }), target },
          appAtomRegistry
            .get(environmentThreadShells.threadShellsAtom)
            .filter((thread) => thread.environmentId === environmentId),
          [...appAtomRegistry.get(pullRequestSnapshotsAtom).values()].flatMap((entry) =>
            entry.environmentId === environmentId ? [entry.summary] : [],
          ),
        );
  return initialSummary === undefined ? params : { ...params, initialSummary };
}

export function useThreadPr(thread: EnvironmentThreadShell): ThreadPrPresentation | null {
  const demand = use(ThreadPrDemandContext);
  const resolve = useMessages();
  const supportsLinks = useAtomValue(
    serverEnvironment.configValueAtom(thread.environmentId),
    (config) => config !== null,
  );
  const { linkedPresentation, pullRequestRef } = useMemo(
    () =>
      resolveThreadPrSource(
        {
          pullRequests: thread.pullRequests,
          linkedPullRequest: thread.linkedPullRequest,
          branchPullRequest: thread.branchPullRequest,
        },
        supportsLinks,
        resolve,
      ),
    [
      thread.pullRequests,
      thread.linkedPullRequest,
      thread.branchPullRequest,
      supportsLinks,
      resolve,
    ],
  );
  const input =
    pullRequestRef === null
      ? null
      : {
          projectId: pullRequestRef.projectId,
          ...legacyThreadPullRequestKey(pullRequestRef),
        };
  const key = input === null ? null : snapshotKey(thread.environmentId, input);
  // Select this row's entry so answers for other pull requests do not re-render it.
  const snapshot = useAtomValue(pullRequestSnapshotsAtom, (current) =>
    key === null ? undefined : current.get(key)?.summary,
  );
  const pullRequestSummary = useEnvironmentQuery(
    input === null || !demand
      ? null
      : pullRequestSummaryAtom({
          environmentId: thread.environmentId,
          input,
        }),
  );
  const summary = pullRequestRef === null ? undefined : (pullRequestSummary.data ?? snapshot);
  // Rows pass `pr` into callbacks; a fresh object per render would invalidate them.
  const summaryPresentation =
    summary === undefined
      ? null
      : presentThreadPr(
          pullRequestDetailToVcsStatus(summary),
          {
            kind: summary.provider,
            name: summary.provider,
            baseUrl: "",
          },
          resolve,
        );
  return linkedPresentation ?? summaryPresentation;
}

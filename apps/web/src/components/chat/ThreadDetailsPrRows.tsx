import { pipe } from "effect/Function";
import { useAtomValue } from "@effect/atom-react";
import { ThreadDetailsMoreButton } from "./ThreadDetailsControl";
import type {
  EnvironmentId,
  ScopedThreadRef,
  ThreadPullRequestLink,
  VcsStatusResult,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  pullRequestListLines,
  normalizeThreadPullRequestKey,
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import { useMessages } from "gt-react";
import { useState, type ComponentProps, type MouseEvent as ReactMouseEvent } from "react";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  findProjectForChangeRequest,
  findProjectOnChangeRequestHost,
} from "@t3tools/client-runtime/change-request-links";

import type { ComposerThreadTarget } from "~/composerDraftStore";
import { useProjects, useQuietThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { useOpenPrLink } from "../../lib/openPullRequestLink";
import {
  linkedPullRequestSnapshotStatus,
  prStatusIndicator,
  useThreadDisplayedPullRequest,
} from "../ThreadStatusIndicators";

import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";

function useSupportsWebTargets(environmentId: EnvironmentId) {
  return useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.pullRequestWebTargets === true,
  );
}

function ThreadDetailsPrLinkRow({
  environmentId,
  link,
  onOpen,
  onActed,
  onStopWatching,
  composerTarget,
}: {
  environmentId: EnvironmentId;
  link: ThreadPullRequestLink;
  onOpen: (event: ReactMouseEvent<HTMLElement>) => void;
  onActed?: (() => void) | undefined;
  onStopWatching?: (() => void) | undefined;
  composerTarget?: ComposerThreadTarget | undefined;
}) {
  const m = useMessages();
  const projects = useProjects();
  const supportsWebTargets = useSupportsWebTargets(environmentId);
  const parsed = sourceControlClients.parseChangeRequestUrl(link.url);
  const project =
    parsed === null
      ? null
      : (findProjectOnChangeRequestHost(
          projects.filter((candidate) => candidate.environmentId === environmentId),
          parsed.link,
          parsed.definition.kind,
          () => supportsWebTargets,
        ) ?? null);
  const linked = linkedPullRequestSnapshotStatus(link);
  const pr = linked?.pr ?? null;
  return (
    <ThreadDetailsPrRow
      environmentId={environmentId}
      pr={pr}
      number={link.number}
      reference={normalizeThreadPullRequestKey(link)}
      status={prStatusIndicator(pr, linked?.sourceControlProvider, m)}
      project={project}
      label={`#${link.number}${link.snapshot === null ? "" : `: ${link.snapshot.title}`}`}
      onOpen={onOpen}
      onStopWatching={onStopWatching}
      composerTarget={composerTarget}
      {...(onActed ? { onActed } : {})}
    />
  );
}

export function ThreadDetailsPrRows({
  threadRef,
  links,
  currentLink,
  onOpenLink,
  ...row
}: ComponentProps<typeof ThreadDetailsPrRow> & {
  threadRef: ScopedThreadRef;
  links: ReadonlyArray<ThreadPullRequestLink>;
  currentLink: ThreadPullRequestLink | null;
  onOpenLink: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });
  const stopWatching = (link: ThreadPullRequestLink | null) =>
    link?.watch === undefined
      ? undefined
      : () =>
          void watch({
            environmentId: threadRef.environmentId,
            input: {
              threadId: threadRef.threadId,
              ...normalizeThreadPullRequestKey(link),
              watching: false,
            },
          });
  const currentRow = <ThreadDetailsPrRow {...row} onStopWatching={stopWatching(currentLink)} />;
  const rest =
    currentLink === null
      ? []
      : pipe(visibleThreadPullRequests(links), resolveThreadPullRequestChains, pullRequestListLines)
          .map((line) => line.link)
          .filter((link) => threadPullRequestKeyOf(link) !== threadPullRequestKeyOf(currentLink));
  if (rest.length === 0) return currentRow;

  return (
    <>
      {currentRow}
      {expanded ? (
        <div data-thread-details-pr-list className="flex flex-col">
          {rest.map((link) => (
            <ThreadDetailsPrLinkRow
              key={threadPullRequestKeyOf(link)}
              environmentId={row.environmentId}
              link={link}
              onOpen={(event) => onOpenLink(event, link.url)}
              onActed={row.onActed}
              onStopWatching={stopWatching(link)}
              composerTarget={row.composerTarget}
            />
          ))}
        </div>
      ) : null}
      <ThreadDetailsMoreButton
        expanded={expanded}
        remaining={rest.length}
        onToggle={() => setExpanded(!expanded)}
      />
    </>
  );
}

/** Linked pull requests need no repository; only the branch's own pull request comes from git. */
export function ThreadDetailsThreadPrRows({
  threadRef,
  project,
  branchPr = null,
  branchSourceControlProvider,
  onActed,
  composerTarget,
}: {
  threadRef: ScopedThreadRef;
  project: EnvironmentProject | null;
  branchPr?: VcsStatusResult["pr"];
  branchSourceControlProvider?: VcsStatusResult["sourceControlProvider"];
  onActed?: () => void;
  composerTarget?: ComposerThreadTarget | undefined;
}) {
  const thread = useQuietThreadShell(threadRef);
  const displayed = useThreadDisplayedPullRequest(
    threadRef.environmentId,
    thread,
    branchPr,
    branchSourceControlProvider,
  );
  const openPrLink = useOpenPrLink(threadRef);
  const { currentLink, pr, number, url } = displayed;
  const projects = useProjects();
  const parsed =
    currentLink === null ? null : sourceControlClients.parseChangeRequestUrl(currentLink.url);
  const candidates = [
    ...(project === null ? [] : [project]),
    ...projects.filter(
      (candidate) =>
        candidate.environmentId === threadRef.environmentId && candidate.id !== project?.id,
    ),
  ];
  const supportsWebTargets = useSupportsWebTargets(threadRef.environmentId);
  const ownProject =
    parsed === null
      ? undefined
      : findProjectForChangeRequest(candidates, parsed.link, parsed.definition.kind);
  const rowProject =
    currentLink === null
      ? project
      : parsed === null
        ? null
        : (ownProject ??
          findProjectOnChangeRequestHost(
            candidates,
            parsed.link,
            parsed.definition.kind,
            () => supportsWebTargets,
          ) ??
          null);
  if (number === undefined || url === undefined) return null;
  return (
    <ThreadDetailsPrRows
      threadRef={threadRef}
      links={thread?.pullRequests ?? []}
      currentLink={currentLink}
      onOpenLink={openPrLink}
      environmentId={threadRef.environmentId}
      pr={pr}
      number={number}
      reference={currentLink === null ? null : normalizeThreadPullRequestKey(currentLink)}
      status={displayed.status}
      project={rowProject}
      mergePreferenceProjectId={ownProject?.id ?? project?.id}
      label={`#${number}${pr?.title.trim() ? `: ${pr.title}` : ""}`}
      onOpen={(event) => openPrLink(event, url)}
      composerTarget={composerTarget}
      {...(onActed ? { onActed } : {})}
    />
  );
}

import type {
  ExecutionEnvironmentCapabilities,
  ThreadId,
  ThreadPullRequestKey,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { findProjectForChangeRequest } from "./changeRequestLinks.ts";
import { sourceControlClients } from "./sourceControlClients.ts";
import type { EnvironmentProject, EnvironmentThreadShell } from "./state/models.ts";
import { normalizeThreadPullRequestKey } from "./threadPullRequests.ts";

/** "unsupported" until the environment's server config has loaded. */
export function threadPullRequestLinkMode(
  capabilities: ExecutionEnvironmentCapabilities | null | undefined,
) {
  return capabilities ? ("multiple" as const) : ("unsupported" as const);
}

/** The server refuses new watches on settled, archived, and subagent threads. */
export function canStartThreadPullRequestWatch(
  thread: Pick<EnvironmentThreadShell, "archivedAt" | "settledAt" | "settledOverride" | "lineage">,
): boolean {
  return (
    thread.archivedAt === null &&
    thread.settledAt === null &&
    thread.settledOverride !== "settled" &&
    thread.lineage.relationshipToParent !== "subagent"
  );
}

export function canWatchLinkedPullRequest({
  capabilities,
  thread,
  project,
  link,
}: {
  capabilities: ExecutionEnvironmentCapabilities | null | undefined;
  thread: Parameters<typeof canStartThreadPullRequestWatch>[0] | null;
  project:
    | Pick<EnvironmentProject, "id" | "environmentId" | "repositoryIdentity">
    | null
    | undefined;
  link: Pick<ThreadPullRequestLink, "url" | "target" | "snapshot" | "watch">;
}): boolean {
  if (capabilities?.threadPullRequestWatch !== true || thread === null) return false;
  if (link.watch !== undefined) return true;
  if (
    !canStartThreadPullRequestWatch(thread) ||
    (link.snapshot !== null && link.snapshot.state !== "open")
  )
    return false;
  if (capabilities.pullRequestWebTargets === true) return true;
  const parsed = sourceControlClients.parseChangeRequestUrl(link.url);
  if (parsed?.definition.kind !== "gitlab") return link.target?.provider !== "gitlab";
  return (
    project != null &&
    findProjectForChangeRequest([project], parsed.link, parsed.definition.kind) !== undefined
  );
}

export function planThreadPullRequestMutation({
  capabilities,
  threadId,
  reference,
  linked,
}: {
  capabilities: ExecutionEnvironmentCapabilities | null | undefined;
  threadId: ThreadId;
  reference: ThreadPullRequestKey & { readonly url: string };
  linked: boolean;
}) {
  const key = normalizeThreadPullRequestKey(reference);
  switch (threadPullRequestLinkMode(capabilities)) {
    case "multiple":
      return linked
        ? {
            type: "thread.pull-request.link" as const,
            input: { threadId, ...reference, ...key, source: "manual" as const },
          }
        : {
            type: "thread.pull-request.unlink" as const,
            input: {
              threadId,
              ...key,
            },
          };
    case "unsupported":
      return null;
  }
}

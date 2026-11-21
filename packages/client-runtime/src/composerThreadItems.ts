import {
  isListedThreadLineage,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";

import type { EnvironmentThreadShell } from "./state/models.ts";
import { threadSearchSubject, type ThreadSearchShell } from "./state/threadSearch.ts";
import { resolveThreadActivityTimestamp } from "./state/threadSort.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const COMPOSER_THREAD_RESULT_LIMIT = 5;

export type ComposerThreadCandidate = ThreadSearchShell &
  Pick<
    EnvironmentThreadShell,
    | "archivedAt"
    | "lineage"
    | "runtime"
    | "latestRun"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "blockedOnThreadWait"
  >;

const THREAD_STATUS_LABELS: Record<
  NonNullable<EnvironmentThreadShell["runtime"]>["status"],
  string
> = {
  preparing: msg("Preparing"),
  queued: msg("Queued"),
  starting: msg("Starting"),
  running: msg("Running"),
  waiting: msg("Waiting"),
  idle: msg("Waiting"),
  completed: msg("Completed"),
  interrupted: msg("Interrupted"),
  failed: msg("Failed"),
  cancelled: msg("Cancelled"),
  rolled_back: msg("Rolled back"),
};

function threadStatusLabel(shell: ComposerThreadCandidate, resolve: MFunctionType): string {
  if (shell.hasPendingApprovals || shell.pendingSubagentRequest === "approval") {
    return resolve(msg("Needs approval"));
  }
  if (shell.hasPendingUserInput || shell.pendingSubagentRequest === "user_input") {
    return resolve(msg("Needs input"));
  }
  const status = shell.runtime?.status ?? shell.latestRun?.status;
  if (status === "running" && shell.blockedOnThreadWait) return resolve(msg("Waiting"));
  return resolve(status === undefined ? msg("Ready") : THREAD_STATUS_LABELS[status]);
}

function relativeTime(timestamp: string, now: number, resolve: MFunctionType): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 60_000));
  if (minutes < 1) return resolve(msg("just now"));
  if (minutes < 60) return resolve(msg("{count}m ago", { count: minutes }));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return resolve(msg("{count}h ago", { count: hours }));
  return resolve(msg("{count}d ago", { count: Math.floor(hours / 24) }));
}

export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
}

/**
 * Threads to reference from the composer, matched and ranked like the command
 * palette, without subagent threads or other threads' side chats. The agent reads threads
 * on its own server and on the machines it links to, so candidates stay within those, and a
 * linked machine's threads say which machine they are on.
 */
export function matchComposerThreadItems(
  input: {
    shells: ReadonlyArray<ComposerThreadCandidate>;
    environmentId: EnvironmentId;
    environmentLabel?: string | null;
    /** The machines the composer's environment links to, by name. */
    linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
    excludeThreadId: ThreadId | null;
    query: string;
    /** Recency is measured against this time. */
    now: number;
  },
  resolve: MFunctionType = mFallback,
): ComposerThreadItem[] {
  const query = foldSearchQuery(input.query);
  if (query.length === 0) return [];
  // Closing an unused side chat deletes it, so only one with a message is offered.
  const isOwnSideChat = (shell: ComposerThreadCandidate) =>
    shell.lineage.sideChat === true &&
    shell.environmentId === input.environmentId &&
    shell.lineage.parentThreadId === input.excludeThreadId &&
    shell.latestUserMessageAt !== null;
  const candidates = input.shells.filter(
    (shell) =>
      (shell.environmentId === input.environmentId ||
        input.linkedEnvironments.has(shell.environmentId)) &&
      shell.id !== input.excludeThreadId &&
      shell.archivedAt === null &&
      (isListedThreadLineage(shell.lineage) || isOwnSideChat(shell)),
  );
  return rankSearchItems(candidates, (shell, options) =>
    scoreThreadSearch(query, threadSearchSubject(shell, null), input.now, {
      ...options,
      picks: false,
    }),
  )
    .slice(0, COMPOSER_THREAD_RESULT_LIMIT)
    .map(({ item: shell }) => {
      const machine =
        shell.environmentId === input.environmentId
          ? (input.environmentLabel ?? resolve(msg("Local machine")))
          : input.linkedEnvironments.get(shell.environmentId);
      const activityTimestamp = resolveThreadActivityTimestamp(shell) ?? shell.createdAt;
      const timestamp =
        Date.parse(shell.updatedAt) > Date.parse(activityTimestamp)
          ? shell.updatedAt
          : activityTimestamp;
      const time = relativeTime(timestamp, input.now, resolve);
      const timestampLabel =
        Date.parse(timestamp) > Date.parse(shell.createdAt)
          ? resolve(msg("Last active {time}", { time }))
          : resolve(msg("Created {time}", { time }));
      return {
        id: `thread:${shell.environmentId}:${shell.id}`,
        type: "thread",
        thread: { environmentId: shell.environmentId, threadId: shell.id },
        label: shell.title,
        description: [
          machine,
          ...(isOwnSideChat(shell) ? [resolve(msg("Side chat"))] : []),
          threadStatusLabel(shell, resolve),
          timestampLabel,
        ].join(" · "),
      };
    });
}

export interface ComposerEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
}

export interface ComposerEnvironmentItem {
  readonly id: string;
  readonly type: "environment";
  readonly environmentId: EnvironmentId;
  readonly machine: EnvironmentMachineKind;
  readonly label: string;
  readonly description: string;
}

/**
 * The user's machines the `@` picker offers, so the agent can link or work there. The
 * composer's own environment is left out. Like threads, they need a query: bare `@` stays a
 * file picker.
 */
export function matchComposerEnvironmentItems(
  input: {
    environments: ReadonlyArray<ComposerEnvironmentCandidate>;
    environmentId: EnvironmentId;
    query: string;
  },
  resolve: MFunctionType = mFallback,
): ComposerEnvironmentItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  return input.environments
    .filter(
      (environment) =>
        environment.environmentId !== input.environmentId &&
        environment.label.toLowerCase().includes(query),
    )
    .map((environment) => ({
      id: `environment:${environment.environmentId}`,
      type: "environment",
      environmentId: environment.environmentId,
      machine: environment.machine,
      label: environment.label,
      description: resolve(msg("Machine", { $context: "noun, search result type" })),
    }));
}

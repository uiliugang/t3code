import {
  IssueTrackerKind,
  RequirementIssueError,
  isMeituanServiceEnabled,
} from "@t3tools/contracts";
import type {
  EnvironmentId,
  IssueListInput,
  IssueListResult,
  IssueScopeRef,
  ProjectId,
  RequirementIssueListInput,
  RequirementIssueListResult,
  WorkItemListInput,
  WorkItemListResult,
  WorkItemSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Array from "effect/Array";
import * as Data from "effect/Data";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { executeAtomQuery } from "./runtime.ts";
import {
  mergeRequirementEntries,
  mergeWorkItemPages,
  type RequirementEntry,
  type RequirementBoardPage,
  type RequirementTracker,
  type RequirementSource,
} from "../workItem.ts";

const unconfiguredSourceMessage = new RequirementIssueError({
  operation: "resolve",
  reason: "invalid-target",
}).message;

type TrackerList = (target: {
  environmentId: EnvironmentId;
  input: IssueListInput;
}) => Atom.Atom<AsyncResult.AsyncResult<IssueListResult, unknown>>;
type TrackerFilters = Pick<
  RequirementBoardKey,
  "source" | "assignee" | "query" | "projectId" | "labels"
>;
function trackerInput(key: TrackerFilters): IssueListInput {
  return {
    state: "all",
    ...(key.labels?.length ? { labels: key.labels } : {}),
    ...(key.assignee === "me" ? { involvement: "assigned" as const } : {}),
    ...(!["all", "me", "unassigned"].includes(key.assignee) ? { assignee: key.assignee } : {}),
    ...(key.query.trim() ? { query: key.query.trim() } : {}),
    ...(key.projectId ? { projectId: key.projectId } : {}),
    ...(key.source !== "all" && key.source !== "local"
      ? { tracker: IssueTrackerKind.make(key.source) }
      : {}),
  };
}
function trackerPage(result: IssueListResult, key: TrackerFilters): RequirementBoardPage {
  type Group = RequirementBoardPage["groups"][number];
  const groups = new Map<
    string,
    Omit<Group, "issues"> & { issues: Array<Group["issues"][number]> }
  >();
  for (const entry of result.entries) {
    const provider = String(entry.tracker);
    if (
      provider !== "github" &&
      provider !== "meituan" &&
      provider !== "gitlab" &&
      provider !== "linear"
    )
      continue;
    if (
      (key.source !== "all" && key.source !== provider) ||
      (key.assignee === "unassigned" && entry.assignees.length)
    )
      continue;
    const id = JSON.stringify([entry.projectId, entry.host, entry.scope]);
    const group = groups.get(id) ?? {
      source: {
        provider: provider as RequirementTracker,
        scope: entry.scope,
        host: entry.host,
      },
      projectIds: [entry.projectId],
      issues: [],
      hasMore: false,
    };
    group.issues.push({
      id: entry.key,
      url: entry.url,
      title: entry.title,
      state: entry.state.name,
      stateCategory:
        entry.state.boardCategory ?? (entry.state.category === "closed" ? "done" : "todo"),
      type: "issue",
      priority: entry.priority ?? "",
      updatedAt: entry.updatedAt,
      assignees: entry.assignees.map((person) => ({
        value: person.login,
        label: person.name ?? person.login,
      })),
    });
    groups.set(id, group);
  }
  return {
    groups: [...groups.values()],
    failures: result.errors.map((error) => ({ projectId: error.projectId, reason: error.message })),
  };
}

export function prefetchRequirementIssues(
  registry: AtomRegistry.AtomRegistry,
  issues: Parameters<typeof createRequirementBoardAtoms>[0]["issues"],
  environmentIds: ReadonlyArray<EnvironmentId>,
  signal?: AbortSignal,
  meituanEnabled?: (environmentId: EnvironmentId) => boolean,
  trackers?: (id: EnvironmentId) => TrackerList | undefined,
) {
  return Promise.all(
    [...new Set(environmentIds)].flatMap((environmentId) => {
      const list = trackers?.(environmentId);
      if (list)
        return [
          executeAtomQuery(
            registry,
            list({
              environmentId,
              input: trackerInput({ source: "all", assignee: "me", projectId: null, query: "" }),
            }),
            { ...(signal ? { signal } : {}), reportFailure: false, reportDefect: false },
          ).then(() => undefined),
        ];
      return (["meituan", "github"] as const)
        .filter((provider) => provider !== "meituan" || meituanEnabled?.(environmentId) !== false)
        .map((provider) =>
          executeAtomQuery(
            registry,
            issues({ environmentId, input: { provider, assignee: "me", query: "", page: 1 } }),
            { ...(signal ? { signal } : {}), reportFailure: false, reportDefect: false },
          ).then(() => undefined),
        );
    }),
  ).then(() => undefined);
}

export class RequirementBoardKey extends Data.Class<{
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  source: RequirementSource;
  assignee: string;
  query: string;
  page: number;
  cursors: ReadonlyArray<WorkItemListInput["cursor"]>;
  localSupported: boolean;
  archived: boolean;
  meituanEnabled?: boolean;
  trackerSupported?: boolean;
  labels?: ReadonlyArray<string>;
}> {}

export function createRequirementBoardAtoms(queries: {
  trackers?: TrackerList;
  issues: (target: {
    environmentId: EnvironmentId;
    input: RequirementIssueListInput;
  }) => Atom.Atom<AsyncResult.AsyncResult<typeof RequirementIssueListResult.Type, unknown>>;
  workItemsLive: (target: {
    environmentId: EnvironmentId;
    input: WorkItemListInput;
  }) => Atom.Atom<AsyncResult.AsyncResult<WorkItemListResult, unknown>>;
}) {
  return Atom.family((key: RequirementBoardKey) =>
    Atom.make((get) => {
      const issuePages: RequirementBoardPage[] = [];
      const scopes: {
        environmentId: EnvironmentId;
        input: IssueScopeRef;
        labels: boolean;
        create: boolean;
      }[] = [];
      const itemPages: WorkItemListResult[] = [];
      const atoms: Array<Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>> = [];
      const errors: string[] = [];
      let isPending = false;
      const read = <A>(atom: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>, live = false) => {
        atoms.push(atom);
        const result = get(atom);
        // Live subscriptions keep waiting between snapshots, including after their first answer.
        isPending ||= result.waiting && !(live && AsyncResult.isSuccess(result));
        if (result._tag === "Failure") {
          const error = Cause.squash(result.cause);
          errors.push(error instanceof Error ? error.message : String(error));
        }
        return AsyncResult.getOrElse(result, () => null);
      };
      let moreIssues = false;
      let nextCursor: WorkItemListInput["cursor"] | null = null;
      if (!key.archived && key.source !== "local" && key.trackerSupported && queries.trackers) {
        let cursors: IssueListInput["cursors"];
        for (let page = 1; page <= key.page; page++) {
          const result: IssueListResult | null = read(
            queries.trackers({
              environmentId: key.environmentId,
              input: { ...trackerInput(key), ...(cursors ? { cursors } : {}) },
            }),
          );
          if (!result) break;
          if (page === 1)
            for (const input of result.scopes ?? []) {
              const tracker = result.trackers.find(
                (entry) => entry.host === input.host && entry.tracker === input.tracker,
              );
              if (tracker?.configured && tracker.capabilities)
                scopes.push({
                  environmentId: key.environmentId,
                  input,
                  labels: tracker.capabilities.labels,
                  create: tracker.capabilities.create,
                });
            }
          issuePages.push(trackerPage(result, key));
          cursors = result.nextCursors;
          if (!Object.keys(cursors).length) break;
          moreIssues = page === key.page;
        }
      } else if (!key.archived && key.source !== "local" && !key.labels?.length) {
        for (const provider of ["meituan", "github"] as const) {
          if (provider === "meituan" && key.meituanEnabled === false) continue;
          if (key.source !== "all" && key.source !== provider) continue;
          for (let page = 1; page <= key.page; page++) {
            const result = read(
              queries.issues({
                environmentId: key.environmentId,
                input: {
                  provider,
                  assignee: key.assignee,
                  query: key.query,
                  page,
                  ...(key.projectId ? { projectId: key.projectId } : {}),
                },
              }),
            );
            if (!result) break;
            issuePages.push(
              key.source === "all"
                ? {
                    ...result,
                    failures: result.failures.filter(
                      (failure) => failure.reason !== unconfiguredSourceMessage,
                    ),
                  }
                : result,
            );
            const hasMore = result.groups.some((group) => group.hasMore);
            if (page === key.page) moreIssues ||= hasMore;
            if (!hasMore) break;
          }
        }
      }
      if (key.localSupported && !key.labels?.length) {
        for (const cursor of key.cursors) {
          const result = read(
            queries.workItemsLive({
              environmentId: key.environmentId,
              input: {
                ...(key.projectId ? { projectId: key.projectId } : {}),
                ...(cursor ? { cursor } : {}),
              },
            }),
            true,
          );
          nextCursor = result?.nextCursor ?? null;
          if (result) itemPages.push(result);
        }
      }
      return {
        issuePages,
        scopes,
        failures: Array.dedupeWith(
          issuePages.flatMap((page) => page.failures),
          (left, right) => left.projectId === right.projectId && left.reason === right.reason,
        ),
        items: mergeWorkItemPages(itemPages),
        candidates: itemPages[0]?.candidates ?? [],
        nextCursor,
        moreIssues,
        isPending,
        errors,
        atoms,
      };
    }),
  );
}

export type RequirementPagination = Readonly<
  Record<
    string,
    {
      page: number;
      cursors: ReadonlyArray<WorkItemListInput["cursor"]>;
    }
  >
>;

export class RequirementOverviewKey extends Data.Class<{
  environmentIds: ReadonlyArray<EnvironmentId>;
  projectId: ProjectId | null;
  source: RequirementSource;
  assignee: string;
  query: string;
  archived: boolean;
  pagination: RequirementPagination;
  labels?: ReadonlyArray<string>;
}> {}

export type EnvironmentRequirementEntry = RequirementEntry & { environmentId: EnvironmentId };

export function createRequirementPermissionAtoms(
  permissions: Record<
    "createIssue" | "mutateWorkItem" | "discoverWorkItems",
    (environmentId: EnvironmentId) => Atom.Atom<boolean>
  >,
) {
  return Atom.family((environmentIds: ReadonlyArray<EnvironmentId>) =>
    Atom.make(
      (get) =>
        new Map(
          environmentIds.map((environmentId) => [
            environmentId,
            {
              createIssue: get(permissions.createIssue(environmentId)),
              mutateWorkItem: get(permissions.mutateWorkItem(environmentId)),
              discoverWorkItems: get(permissions.discoverWorkItems(environmentId)),
            },
          ]),
        ),
    ),
  );
}

export function createRequirementOverviewAtoms(
  queries: Parameters<typeof createRequirementBoardAtoms>[0] & {
    config: (environmentId: EnvironmentId) => Atom.Atom<{
      readonly workItems?: boolean;
      readonly requirementIssueTrackers?: boolean;
    } | null>;
    settings?: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<Parameters<typeof isMeituanServiceEnabled>[0]>;
    tracked: (
      environmentId: EnvironmentId,
      urls: ReadonlyArray<string>,
    ) => Atom.Atom<ReadonlyMap<string, WorkItemSummary>>;
  },
) {
  const boards = createRequirementBoardAtoms(queries);
  return Atom.family((key: RequirementOverviewKey) =>
    Atom.make((get) => {
      const environments = key.environmentIds.map((environmentId) => {
        const pagination = key.pagination[environmentId] ?? { page: 1, cursors: [undefined] };
        const data = get(
          boards(
            new RequirementBoardKey({
              projectId: key.projectId,
              source: key.source,
              assignee: key.assignee,
              query: key.query,
              archived: key.archived,
              ...(key.labels?.length ? { labels: key.labels } : {}),
              ...pagination,
              environmentId,
              localSupported: get(queries.config(environmentId))?.workItems === true,
              trackerSupported:
                get(queries.config(environmentId))?.requirementIssueTrackers === true,
              meituanEnabled: queries.settings
                ? isMeituanServiceEnabled(get(queries.settings(environmentId)), "requirements")
                : true,
            }),
          ),
        );
        const tracked = get(
          queries.tracked(
            environmentId,
            data.issuePages.flatMap((page) =>
              page.groups.flatMap((group) => group.issues.map((issue) => issue.url)),
            ),
          ),
        );
        return {
          environmentId,
          ...data,
          entries: mergeRequirementEntries(data.issuePages, data.items, tracked, key).map(
            (entry) => ({
              ...entry,
              environmentId,
              key: JSON.stringify([environmentId, entry.key]),
            }),
          ),
          pagination,
        };
      });
      return {
        entries: environments
          .flatMap((environment) => environment.entries)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key)),
        issuePages: environments.flatMap((environment) => environment.issuePages),
        scopes: environments.flatMap((environment) => environment.scopes),
        errors: environments.flatMap(({ environmentId, errors }) =>
          [...new Set(errors)].map((message) => ({ environmentId, message })),
        ),
        failures: environments.flatMap(({ environmentId, failures }) =>
          failures.map((failure) => ({ ...failure, environmentId })),
        ),
        candidates: environments.flatMap(({ environmentId, candidates }) =>
          candidates.map((candidate) => ({ ...candidate, environmentId })),
        ),
        atoms: environments.flatMap((environment) => environment.atoms),
        isPending: environments.some((environment) => environment.isPending),
        hasMore: environments.some(
          (environment) => environment.moreIssues || environment.nextCursor,
        ),
        nextPagination: Object.fromEntries(
          environments.map(({ environmentId, pagination, moreIssues, nextCursor }) => [
            environmentId,
            {
              page: pagination.page + (moreIssues ? 1 : 0),
              cursors: nextCursor ? [...pagination.cursors, nextCursor] : pagination.cursors,
            },
          ]),
        ),
      };
    }),
  );
}

import { IssueError } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ProjectId,
  IssueListInput,
  IssueListResult,
  WorkItemListInput,
  WorkItemListResult,
  WorkItemSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Array from "effect/Array";
import * as Data from "effect/Data";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  mergeRequirementEntries,
  mergeWorkItemPages,
  type RequirementEntry,
  type RequirementSource,
} from "../workItem.ts";

const unconfiguredSourceMessage = new IssueError({ operation: "resolve", reason: "invalid-target" })
  .message;

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
}> {}

export function createRequirementBoardAtoms(queries: {
  issues: (target: {
    environmentId: EnvironmentId;
    input: IssueListInput;
  }) => Atom.Atom<AsyncResult.AsyncResult<typeof IssueListResult.Type, unknown>>;
  workItemsLive: (target: {
    environmentId: EnvironmentId;
    input: WorkItemListInput;
  }) => Atom.Atom<AsyncResult.AsyncResult<WorkItemListResult, unknown>>;
}) {
  return Atom.family((key: RequirementBoardKey) =>
    Atom.make((get) => {
      const issuePages: Array<typeof IssueListResult.Type> = [];
      const itemPages: WorkItemListResult[] = [];
      const atoms: Array<Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>> = [];
      const errors: string[] = [];
      let isPending = false;
      const read = <A>(atom: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>) => {
        atoms.push(atom);
        const result = get(atom);
        isPending ||= result.waiting;
        if (result._tag === "Failure") {
          const error = Cause.squash(result.cause);
          errors.push(error instanceof Error ? error.message : String(error));
        }
        return AsyncResult.getOrElse(result, () => null);
      };
      let moreIssues = false;
      let nextCursor: WorkItemListInput["cursor"] | null = null;
      if (!key.archived && key.source !== "local") {
        for (const provider of ["meituan", "github"] as const) {
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
      if (key.localSupported) {
        for (const cursor of key.cursors) {
          const result = read(
            queries.workItemsLive({
              environmentId: key.environmentId,
              input: {
                ...(key.projectId ? { projectId: key.projectId } : {}),
                ...(cursor ? { cursor } : {}),
              },
            }),
          );
          nextCursor = result?.nextCursor ?? null;
          if (result) itemPages.push(result);
        }
      }
      return {
        issuePages,
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
    config: (environmentId: EnvironmentId) => Atom.Atom<{ readonly workItems?: boolean } | null>;
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
              ...pagination,
              environmentId,
              localSupported: get(queries.config(environmentId))?.workItems === true,
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

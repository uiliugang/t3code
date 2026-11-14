import { IssueError } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ProjectId,
  IssueListInput,
  IssueListResult,
  WorkItemListInput,
  WorkItemListResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import { AsyncResult, Atom } from "effect/reactivity";
import { mergeWorkItemPages, type RequirementSource } from "../workItem.ts";

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
      if (key.localSupported && (key.source === "all" || key.source === "local")) {
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

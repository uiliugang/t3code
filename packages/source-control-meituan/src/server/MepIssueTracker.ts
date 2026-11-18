import { IssueTrackerKind, type Issue, type RequirementIssueError } from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueScopeTarget,
  type IssueTrackerApi,
  type TrackerIssueSummary,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as MepIssueBoard from "./MepIssueBoard.ts";

const kind = IssueTrackerKind.make("meituan");
const failure = (operation: string, detail: string) =>
  new IssueTrackerError({ tracker: kind, operation, detail, reason: "failed" });
const fromBoardError = (error: RequirementIssueError) => failure(error.operation, error.message);

function date(value: string | undefined): string {
  if (!value) return "";
  return Option.match(DateTime.make(/^\d+$/u.test(value) ? Number(value) : value), {
    onNone: () => "",
    onSome: DateTime.formatIso,
  });
}

function summary(issue: Issue): TrackerIssueSummary {
  return {
    key: issue.id,
    displayKey: `#${issue.id}`,
    title: issue.title,
    url: issue.url,
    state: {
      category: issue.stateCategory === "done" ? "closed" : "open",
      name: issue.state,
      boardCategory: issue.stateCategory,
    },
    priority: issue.priority,
    author: null,
    createdAt: date(issue.createdAt),
    updatedAt: date(issue.updatedAt),
    closedAt: null,
    assignees: issue.assignees.map(({ value, label }) => ({
      login: value,
      name: label,
      avatarUrl: null,
    })),
    labels: [],
    commentCount: 0,
  };
}

const source = (target: IssueScopeTarget, key?: string) =>
  target.host === "mep.sankuai.com" &&
  /^[1-9]\d*$/u.test(target.scope) &&
  (key === undefined || /^[1-9]\d*$/u.test(key))
    ? Effect.succeed({ provider: "meituan" as const, host: target.host, scope: target.scope })
    : Effect.fail(failure("resolve", "Invalid MEP ONES space or issue ID."));

export const make = Effect.gen(function* () {
  const board = yield* MepIssueBoard.make;
  return {
    kind,
    capabilities: {
      create: false,
      edit: false,
      comment: false,
      labels: false,
      assignees: false,
      reactions: false,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: true,
    },
    getViewer: ({ cwd }) => board.getViewer(cwd).pipe(Effect.mapError(fromBoardError)),
    listIssues: Effect.fn("MepIssueTracker.listIssues")(function* (input) {
      const bound = yield* source(input);
      if (
        input.involvement === "authored" ||
        input.involvement === "mentioned" ||
        input.sort === "created"
      )
        return yield* failure("list", "MEP ONES does not support this filter or sort order.");
      if (
        input.labels?.length ||
        (input.involvement === "assigned" && input.assignee && input.viewer !== input.assignee)
      )
        return { items: [], nextCursor: null };
      const page = Number(input.cursor ?? "1");
      if (!Number.isSafeInteger(page) || page < 1)
        return yield* failure("list", "Invalid ONES page cursor.");
      const result = yield* board
        .search({
          source: bound,
          cwd: input.cwd,
          page,
          pageSize: Math.min(input.limit, 100),
          assignee: input.assignee ?? (input.involvement === "assigned" ? input.viewer : "all"),
          query: input.query ?? "",
        })
        .pipe(Effect.mapError(fromBoardError));
      return {
        items: result.issues
          .map(summary)
          .filter((item) => input.state === "all" || item.state.category === input.state),
        nextCursor: result.hasMore ? String(page + 1) : null,
      };
    }),
    getIssue: Effect.fn("MepIssueTracker.getIssue")(function* (input) {
      const bound = yield* source(input, input.key);
      const detail = yield* board
        .read({ source: bound, cwd: input.cwd, id: input.key })
        .pipe(Effect.mapError(fromBoardError));
      const item = summary(detail);
      return {
        ...item,
        body: detail.body,
        bodyFormat: detail.bodyFormat,
        viewer: null,
        viewerPermissions: {
          setState: detail.transitions.length > 0,
          edit: false,
          comment: false,
          labels: false,
          assignees: false,
        },
        states: [
          item.state,
          ...detail.transitions
            .filter((option) => option.label !== item.state.name)
            .map((option) => ({
              category: option.category === "DONE" ? ("closed" as const) : ("open" as const),
              name: option.label,
            })),
        ],
        comments: [],
        commentsCursor: null,
        events: [],
        linkedPullRequests: [],
      };
    }),
    getComments: () => Effect.succeed({ comments: [], nextCursor: null }),
    setState: Effect.fn("MepIssueTracker.setState")(function* (input) {
      const bound = yield* source(input, input.key);
      yield* board
        .setState({
          source: bound,
          cwd: input.cwd,
          id: input.key,
          state: input.state,
          byName: true,
        })
        .pipe(Effect.mapError(fromBoardError));
    }),
  } satisfies IssueTrackerApi;
});

import { IssueError, type Issue, type IssueSource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as GitHubRest from "./GitHubRest.ts";
import type * as Provider from "@t3tools/source-control-core/server/SourceControlProvider";

const Person = Schema.Struct({ login: Schema.String });
const MAX_ASSIGNEE_PAGES = 10;
const Row = Schema.Struct({
  number: Schema.Number,
  html_url: Schema.String,
  title: Schema.String,
  state: Schema.String,
  state_reason: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.String,
  assignees: Schema.Array(Person),
  pull_request: Schema.optional(Schema.Unknown),
});
const issue = (row: typeof Row.Type): Issue => ({
  id: String(row.number),
  url: row.html_url,
  title: row.title,
  state: row.state_reason ? `${row.state} · ${row.state_reason}` : row.state,
  stateCategory: row.state === "closed" ? "done" : "todo",
  type: "Issue",
  priority: "",
  updatedAt: row.updated_at,
  assignees: row.assignees.map((person) => ({ value: person.login, label: person.login })),
});

export const make = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const request = Effect.fn("GitHubIssues.request")(function* <A>(
    source: IssueSource,
    path: string,
    schema: Schema.Codec<A, unknown, never, never>,
    method: "GET" | "POST" | "PATCH" = "GET",
    body?: unknown,
  ) {
    return yield* api
      .rest({
        host: source.host,
        operation: "issues",
        path,
        method,
        ...(body === undefined ? {} : { body }),
        maxResponseBytes: 2_000_000,
      })
      .pipe(
        Effect.flatMap((result) => Schema.decodeEffect(Schema.fromJsonString(schema))(result.body)),
        Effect.mapError(
          (cause) =>
            new IssueError({
              operation: "github",
              reason:
                cause._tag === "GitHubApiResponseError" && cause.status === 422
                  ? "validation"
                  : method !== "GET" &&
                      (cause._tag === "GitHubApiRequestError" ||
                        cause._tag === "SchemaError" ||
                        (cause._tag === "GitHubApiResponseError" && cause.status >= 500))
                    ? "outcome-unknown"
                    : "unavailable",
              ...(cause._tag === "GitHubApiResponseError" && cause.status === 422
                ? {
                    fields: (cause.githubErrors ?? []).map((message) => ({
                      variable: "github",
                      message,
                    })),
                  }
                : {}),
              cause,
            }),
        ),
      );
  });
  const viewer = Effect.fn("GitHubIssues.viewer")(function* (source: IssueSource) {
    return (yield* request(source, "user", Person)).login;
  });
  const read: NonNullable<Provider.SourceControlProvider["Service"]["issueBoard"]>["read"] =
    Effect.fn("GitHubIssues.read")(function* ({ source, id }) {
      const row = yield* request(
        source,
        `repos/${source.scope}/issues/${encodeURIComponent(id)}`,
        Row,
      );
      if (row.pull_request !== undefined)
        return yield* new IssueError({ operation: "read", reason: "invalid-target" });
      return {
        ...issue(row),
        body: row.body ?? "",
        bodyFormat: "markdown" as const,
        transitions:
          row.state === "closed"
            ? [{ value: "open", label: "Reopen" }]
            : [
                { value: "completed", label: "Close as completed" },
                { value: "not_planned", label: "Close as not planned" },
              ],
      };
    });
  return {
    search: Effect.fn("GitHubIssues.search")(function* (input) {
      const assignee = input.assignee === "me" ? yield* viewer(input.source) : input.assignee;
      if (!["all", "unassigned"].includes(assignee) && !/^[a-z\d-]+$/iu.test(assignee))
        return yield* new IssueError({ operation: "search", reason: "validation" });
      if (input.query) {
        const terms = [`repo:${input.source.scope}`, "is:issue"];
        if (assignee !== "all")
          terms.push(assignee === "unassigned" ? "no:assignee" : `assignee:${assignee}`);
        const number = /^#?([1-9]\d*)$/u.exec(input.query)?.[1];
        if (number) {
          const result = yield* read({ ...input, id: number });
          const matches =
            assignee === "all" ||
            (assignee === "unassigned"
              ? !result.assignees.length
              : result.assignees.some((person) => person.value === assignee));
          return { issues: matches && input.page === 1 ? [result] : [], hasMore: false };
        }
        terms.push(`"${input.query.replace(/[\\"]/gu, " ")}"`, "in:title");
        const params = new URLSearchParams({
          q: terms.join(" "),
          sort: "updated",
          order: "desc",
          per_page: "50",
          page: String(input.page),
        });
        const result = yield* request(
          input.source,
          `search/issues?${params}`,
          Schema.Struct({ items: Schema.Array(Row), total_count: Schema.Number }),
        );
        return {
          issues: result.items.map(issue),
          hasMore: input.page * 50 < Math.min(result.total_count, 1000),
        };
      }
      const params = new URLSearchParams({
        state: "all",
        sort: "updated",
        direction: "desc",
        per_page: "50",
        page: String(input.page),
      });
      if (assignee !== "all") params.set("assignee", assignee === "unassigned" ? "none" : assignee);
      const rows = yield* request(
        input.source,
        `repos/${input.source.scope}/issues?${params}`,
        Schema.Array(Row),
      );
      return {
        issues: rows.filter((row) => row.pull_request === undefined).map(issue),
        hasMore: rows.length === 50,
      };
    }),
    read,
    people: Effect.fn("GitHubIssues.people")(function* ({ source, query }) {
      const people = [];
      const keyword = query.toLowerCase();
      for (let page = 1; page <= MAX_ASSIGNEE_PAGES; page++) {
        const rows = yield* request(
          source,
          `repos/${source.scope}/assignees?per_page=100&page=${page}`,
          Schema.Array(Person),
        );
        people.push(
          ...rows
            .filter((row) => row.login.toLowerCase().includes(keyword))
            .map((row) => ({ value: row.login, label: row.login })),
        );
        if (rows.length < 100) break;
      }
      return people;
    }),
    metadata: () => Effect.succeed({ subtypes: [], fields: [] }),
    create: Effect.fn("GitHubIssues.create")(function* (input) {
      return issue(
        yield* request(input.source, `repos/${input.source.scope}/issues`, Row, "POST", {
          title: input.title,
          body: input.body,
          assignees: input.assignees,
        }),
      );
    }),
    setState: Effect.fn("GitHubIssues.setState")(function* (input) {
      const current = yield* read(input);
      if (!current.transitions.some((option) => option.value === input.state))
        return yield* new IssueError({ operation: "setState", reason: "invalid-state" });
      yield* request(
        input.source,
        `repos/${input.source.scope}/issues/${encodeURIComponent(input.id)}`,
        Row,
        "PATCH",
        input.state === "open" ? { state: "open" } : { state: "closed", state_reason: input.state },
      );
    }),
  } satisfies NonNullable<Provider.SourceControlProvider["Service"]["issueBoard"]>;
});

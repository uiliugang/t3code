import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GitHubRest from "./GitHubRest.ts";
import * as Board from "./GitHubIssues.ts";

const source = { provider: "github" as const, host: "github.com", scope: "acme/repo" };
const row = {
  number: 5,
  html_url: "https://github.com/acme/repo/issues/5",
  title: "Old matching issue",
  state: "closed",
  state_reason: "not_planned",
  updated_at: "2026-01-01T00:00:00Z",
  assignees: [{ login: "teammate" }],
};

describe("GitHub issue board", () => {
  it.effect("finds assignees beyond the first page and bounds full-page lookups", () =>
    Effect.gen(function* () {
      const calls: GitHubRest.GitHubRestInput[] = [];
      let fullPages = false;
      const board = yield* Board.make.pipe(
        Effect.provide(
          Layer.mock(GitHubRest.GitHubRest)({
            rest: (input) => {
              calls.push(input);
              const page = new URLSearchParams(input.path.split("?")[1]).get("page") ?? "1";
              return Effect.succeed({
                status: 200,
                headers: {},
                truncated: false,
                invalidUtf8: false,
                body: JSON.stringify(
                  page === "1" || fullPages
                    ? Array.from({ length: 100 }, (_, index) => ({
                        login: `user-${page}-${index}`,
                      }))
                    : [{ login: "Late-Teammate" }],
                ),
              });
            },
          }),
        ),
      );
      expect(yield* board.people({ cwd: "/repo", source, query: "late-team" })).toEqual([
        { value: "Late-Teammate", label: "Late-Teammate" },
      ]);
      expect(calls).toHaveLength(2);
      calls.length = 0;
      fullPages = true;
      yield* board.people({ cwd: "/repo", source, query: "absent" });
      expect(calls).toHaveLength(10);
    }),
  );
  it.effect(
    "searches the repository on the server and preserves native closure reasons and reopening",
    () =>
      Effect.gen(function* () {
        const calls: GitHubRest.GitHubRestInput[] = [];
        const board = yield* Board.make.pipe(
          Effect.provide(
            Layer.mock(GitHubRest.GitHubRest)({
              rest: (input) => {
                calls.push(input);
                return Effect.succeed({
                  status: 200,
                  headers: {},
                  body: JSON.stringify(
                    input.path.startsWith("search/") ? { items: [row], total_count: 51 } : row,
                  ),
                  truncated: false,
                  invalidUtf8: false,
                });
              },
            }),
          ),
        );
        const result = yield* board.search({
          cwd: "/repo",
          source,
          query: "Old matching",
          assignee: "teammate",
          page: 1,
        });
        const params = new URLSearchParams(calls[0]!.path.split("?")[1]);
        expect(params.get("q")).toBe(
          'repo:acme/repo is:issue assignee:teammate "Old matching" in:title',
        );
        expect(result).toMatchObject({
          hasMore: true,
          issues: [{ state: "closed · not_planned", stateCategory: "done" }],
        });
        expect((yield* board.read({ cwd: "/repo", source, id: "5" })).transitions).toEqual([
          { value: "open", label: "Reopen" },
        ]);
        expect(
          (yield* board
            .setState({ cwd: "/repo", source, id: "5", state: "doing" })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid-state");
        yield* board.setState({ cwd: "/repo", source, id: "5", state: "open" });
        expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([
          { state: "open" },
        ]);
      }),
  );
});

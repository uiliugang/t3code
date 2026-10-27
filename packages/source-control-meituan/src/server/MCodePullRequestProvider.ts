import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type PullRequestProviderApi,
  type ProviderRepositoryRef,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { definition } from "../shared/definition.ts";
import * as MCodeCli from "./MCodeCli.ts";
import * as Json from "./mcodeJson.ts";

const isRepositoryName = Schema.is(Json.RepositoryName);

const decodeChecks = Schema.decodeEffect(Schema.fromJsonString(Json.Checks));

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  search: true,
  reactions: false,
  review: {
    inlineComment: false,
    reply: false,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  // code-cli can add reviewers but cannot remove them, so the toggle is not offered.
  reviewers: { request: false, listCandidates: true },
};

export const make = Effect.gen(function* () {
  const cli = yield* MCodeCli.MCodeCli;
  const failure = (cause: MCodeCli.MCodeError) =>
    new PullRequestProviderError({
      provider: definition.kind,
      operation: cause.operation,
      reason:
        cause.reason === "missing-tool" ||
        cause.reason === "unauthenticated" ||
        cause.reason === "rate-limited" ||
        cause.reason === "not-found"
          ? cause.reason
          : "failed",
      detail: cause.message,
      cause,
    });
  const unsupported = (operation: string) =>
    Effect.fail(failure(new MCodeCli.MCodeError({ operation, reason: "unsupported" })));
  const validate = (input: ProviderRepositoryRef, operation: string) =>
    input.host === "git.sankuai.com" && isRepositoryName(input.repository)
      ? Effect.void
      : Effect.fail(failure(new MCodeCli.MCodeError({ operation, reason: "invalid-repository" })));
  const read = <A>(
    input: ProviderRepositoryRef,
    operation: string,
    args: ReadonlyArray<string>,
    schema: Schema.Codec<A, unknown, never, never>,
    group = "pr",
  ) =>
    validate(input, operation).pipe(
      Effect.andThen(
        cli
          .json(
            { cwd: input.cwd, operation, args: [group, "-R", input.repository, ...args, "--json"] },
            schema,
          )
          .pipe(Effect.mapError(failure)),
      ),
    );
  const run = (input: ProviderRepositoryRef, operation: string, args: ReadonlyArray<string>) =>
    validate(input, operation).pipe(
      Effect.andThen(
        cli
          .run({ cwd: input.cwd, operation, args: ["pr", "-R", input.repository, ...args] })
          .pipe(Effect.mapError(failure)),
      ),
      Effect.asVoid,
    );
  const getPr = (input: ProviderRepositoryRef & { readonly number: number }) =>
    read(input, "getChangeRequest", ["view", String(input.number)], Json.PullRequest);
  const getViewer = Effect.fn("MCodePullRequestProvider.getViewer")(function* (input: {
    readonly cwd: string;
    readonly host?: string;
  }) {
    if (input.host && input.host !== "git.sankuai.com") return yield* unsupported("getViewer");
    const auth = MCodeCli.parseMCodeAuth(
      yield* cli
        .run({ cwd: input.cwd, operation: "getViewer", args: ["auth", "status"] })
        .pipe(Effect.mapError(failure)),
    );
    if (auth.status !== "authenticated" || Option.isNone(auth.account))
      return yield* failure(
        new MCodeCli.MCodeError({ operation: "getViewer", reason: "unauthenticated" }),
      );
    return auth.account.value;
  });
  const permissions = (pr: Json.PullRequest, viewer: string): PullRequestViewerPermissions => ({
    actions: CAPABILITIES.actions,
    comment: true,
    resolve: true,
    requestReviewers: false,
    verdicts:
      pr.author.mis.toLowerCase() === viewer.toLowerCase()
        ? ["comment"]
        : CAPABILITIES.review.verdicts,
  });
  const checks = Effect.fn("MCodePullRequestProvider.checks")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    yield* validate(input, "getChecks");
    // code-cli reports partial request failures only in verbose stderr, even with exit code zero.
    const output = yield* cli
      .run({
        cwd: input.cwd,
        operation: "getChecks",
        args: ["--verbose", "pr", "-R", input.repository, "checks", String(input.number), "--json"],
      })
      .pipe(Effect.mapError(failure));
    const decoded = yield* decodeChecks(output.stdout).pipe(
      Effect.mapError((cause) =>
        failure(
          new MCodeCli.MCodeError({ operation: "getChecks", reason: "invalid-response", cause }),
        ),
      ),
    );
    const results = Json.checksFromJson(decoded);
    return output.stderrTruncated ||
      /\[DEBUG\] (?:status-checks|merge-status) request failed:/u.test(output.stderr)
      ? [
          ...results,
          {
            name: "Check availability",
            status: "pending" as const,
            description:
              "Some Meituan Code checks could not be loaded. Retry or check the repository website.",
            url: null,
          },
        ]
      : results;
  });
  const changedFiles = Effect.fn("MCodePullRequestProvider.changedFiles")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    yield* validate(input, "changedFiles");
    const output = yield* cli
      .run({
        cwd: input.cwd,
        operation: "changedFiles",
        args: [
          "pr",
          "-R",
          input.repository,
          "diff",
          String(input.number),
          "--color",
          "never",
          "--name-only",
        ],
      })
      .pipe(Effect.mapError(failure));
    if (output.stdoutTruncated)
      return yield* failure(
        new MCodeCli.MCodeError({ operation: "changedFiles", reason: "invalid-response" }),
      );
    return output.stdout.split(/\r?\n/u).filter(Boolean).length;
  });

  const provider: PullRequestProviderApi = {
    kind: definition.kind,
    capabilities: CAPABILITIES,
    unavailableRequirement: {
      missing: "Install code-cli 0.1.27 or newer on the server to use Meituan Code.",
      unauthenticated: "Run code-cli auth login on the server, then retry.",
    },
    readsPublicHostWithoutCheckout: true,
    getViewer,
    listChangeRequests: Effect.fn("MCodePullRequestProvider.listChangeRequests")(function* (input) {
      const offset = input.cursor?.delivered ?? 0;
      if (offset >= 1000) return { items: [], truncated: true, continues: false };
      const limit = Math.min(offset + input.limit + 1, 1000);
      const rows = yield* read(
        input,
        "listChangeRequests",
        [
          "list",
          "--state",
          input.state,
          "--limit",
          String(limit),
          ...(input.involvement === "authored" ? ["--author", input.viewer] : []),
          ...(input.query ? ["--filter-title", input.query] : []),
        ],
        Schema.Array(Json.PullRequest),
      );
      const page = rows.slice(offset, offset + input.limit);
      return {
        items: page
          .filter(
            (pr) =>
              input.involvement !== "reviewing" ||
              pr.reviewers.some((user) => user.mis.toLowerCase() === input.viewer.toLowerCase()),
          )
          .map(Json.providerChangeRequest),
        cursorAdvance: page.length,
        truncated: rows.length >= 1000,
        continues: rows.length > offset + input.limit,
      };
    }),
    getChangeRequestSummary: (input) => getPr(input).pipe(Effect.map(Json.providerChangeRequest)),
    getChangeRequestChecks: Effect.fn("MCodePullRequestProvider.getChangeRequestChecks")(
      function* (input) {
        const [pr, results] = yield* Effect.all([getPr(input), checks(input)], { concurrency: 2 });
        return { state: Json.changeRequest(pr).state, checks: results };
      },
    ),
    getChangeRequest: Effect.fn("MCodePullRequestProvider.getChangeRequest")(function* (input) {
      const [pr, results, viewer, fileCount] = yield* Effect.all(
        [getPr(input), checks(input), getViewer(input), changedFiles(input)],
        { concurrency: 4 },
      );
      return {
        ...Json.providerChangeRequest(pr),
        headSha: pr.fromRef.commitId || null,
        body: pr.description,
        changedFiles: fileCount,
        mergedAt: null,
        closedAt: null,
        reviewers: pr.reviewers.flatMap((user) => {
          const result = Json.actor(user);
          return result ? [result] : [];
        }),
        checks: results,
        mergeCapabilities: { merge: true, squash: true, rebase: true },
        viewerPermissions: permissions(pr, viewer),
      };
    }),
    getViewerPermissions: Effect.fn("MCodePullRequestProvider.getViewerPermissions")(
      function* (input) {
        const [pr, viewer] = yield* Effect.all([getPr(input), getViewer(input)], {
          concurrency: 2,
        });
        return permissions(pr, viewer);
      },
    ),
    getChangeRequestActivity: Effect.fn("MCodePullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const rows = yield* read(
          input,
          "getActivity",
          ["comments", String(input.number), "--state", "all"],
          Json.Comments,
        );
        return {
          comments: rows
            .filter((row) => !row.path)
            .map((row) => ({
              id: `${row.source}:${row.id}`,
              kind: "issue-comment" as const,
              author: row.author ? { login: row.author, name: null, avatarUrl: null } : null,
              body: row.text,
              createdAt: Json.timestamp(row.createdDate),
              url: null,
              path: null,
              reviewState: null,
            })),
          commentCount: rows.filter((row) => !row.path).length,
          // code-cli lists assignments, not the complete discussion or commit history.
          commentsTruncated: true,
          reviewThreadsTruncated: true,
          commits: [],
          reviewThreads: rows
            .filter((row) => row.path)
            .map((row) => ({
              id: `${row.source}:${row.assignmentId || row.id}`,
              path: row.path,
              line: row.line > 0 ? row.line : null,
              side: "right" as const,
              isResolved: row.state.toLowerCase() === "resolved",
              isOutdated: false,
              canResolve: row.source === "human" && Boolean(row.assignmentId),
              comments: [
                {
                  id: row.id,
                  author: row.author ? { login: row.author, name: null, avatarUrl: null } : null,
                  body: row.text,
                  createdAt: Json.timestamp(row.createdDate),
                  url: null,
                },
              ],
              commentCount: 1 + (row.replies ?? 0),
            })),
        };
      },
    ),
    getDiff: Effect.fn("MCodePullRequestProvider.getDiff")(function* (input) {
      if (input.cursor || input.commit) return yield* unsupported("getDiff");
      yield* validate(input, "getDiff");
      const result = yield* cli
        .run({
          cwd: input.cwd,
          operation: "getDiff",
          args: ["pr", "-R", input.repository, "diff", String(input.number), "--color", "never"],
          maxOutputBytes: 8_000_000,
        })
        .pipe(Effect.mapError(failure));
      return { patch: result.stdout, truncated: result.stdoutTruncated, nextCursor: null };
    }),
    runAction: Effect.fn("MCodePullRequestProvider.runAction")(function* (input) {
      const number = String(input.number);
      switch (input.action) {
        case "ready":
        case "close":
        case "reopen":
          return yield* run(input, input.action, [input.action, number]);
        case "merge":
          return yield* run(input, "merge", ["merge", number, `--${input.mergeMethod ?? "merge"}`]);
        default:
          return yield* unsupported(input.action);
      }
    }),
    comment: (input) =>
      run(input, "comment", ["comment", String(input.number), "--body", input.body]),
    submitReview: Effect.fn("MCodePullRequestProvider.submitReview")(function* (input) {
      if (input.comments.length) return yield* unsupported("inlineReview");
      if (input.verdict !== "comment") {
        const [pr, viewer] = yield* Effect.all([getPr(input), getViewer(input)], {
          concurrency: 2,
        });
        if (pr.author.mis.toLowerCase() === viewer.toLowerCase())
          return yield* failure(
            new MCodeCli.MCodeError({ operation: "submitReview", reason: "self-review" }),
          );
        yield* run(input, "submitReview", [
          "review",
          String(input.number),
          input.verdict === "approve" ? "--approve" : "--reject",
        ]);
      }
      if (input.body.trim())
        yield* run(input, "reviewComment", ["comment", String(input.number), "--body", input.body]);
    }),
    listReviewerCandidates: Effect.fn("MCodePullRequestProvider.listReviewerCandidates")(
      function* (input) {
        const pr = yield* getPr(input);
        const result = yield* read(
          input,
          "listReviewerCandidates",
          ["reviewers", "--target", pr.toRef.branch],
          Json.Reviewers,
          "repo",
        );
        const candidates = "candidates" in result ? result.candidates : result;
        return {
          candidates: candidates
            .filter((user) => user.mis && user.mis.toLowerCase() !== pr.author.mis.toLowerCase())
            .map((user) => ({
              id: user.mis,
              kind: "user" as const,
              login: user.mis,
              name: user.name || null,
              avatarUrl: null,
              isRequested: pr.reviewers.some((reviewer) => reviewer.mis === user.mis),
            })),
          truncated: false,
        };
      },
    ),
    setReviewerRequest: () => unsupported("setReviewerRequest"),
    replyToThread: () => unsupported("replyToThread"),
    setReaction: () => unsupported("setReaction"),
    setThreadResolution: (input) =>
      /^human:\d+$/u.test(input.threadId)
        ? run(input, "setThreadResolution", [
            input.resolved ? "resolve" : "unresolve",
            String(input.number),
            input.threadId.slice("human:".length),
          ])
        : unsupported("setThreadResolution"),
  };
  return provider;
});

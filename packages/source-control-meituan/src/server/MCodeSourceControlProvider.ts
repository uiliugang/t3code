import { SourceControlProviderError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import { definition, parsePullRequestUrl } from "../shared/definition.ts";
import * as MCodeCli from "./MCodeCli.ts";
import * as Json from "./mcodeJson.ts";

const isRepositoryName = Schema.is(Json.RepositoryName);

export const make = Effect.gen(function* () {
  const cli = yield* MCodeCli.MCodeCli;
  const host = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const failure = (cwd: string, operation: string) => (cause: MCodeCli.MCodeError) =>
    new SourceControlProviderError({
      provider: definition.kind,
      cwd,
      operation,
      detail: cause.message,
      cause,
    });

  const repository = Effect.fn("MCodeSourceControlProvider.repository")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository?: string;
  }) {
    if (input.repository && isRepositoryName(input.repository)) return input.repository;
    if (input.repository)
      return yield* new MCodeCli.MCodeError({
        operation: "repository",
        reason: "invalid-repository",
      });
    const remote =
      input.context?.remoteUrl ??
      (yield* host.git.resolvePrimaryRemoteName(input.cwd).pipe(
        Effect.flatMap((name) => host.git.readConfigValue(input.cwd, `remote.${name}.url`)),
        Effect.mapError(
          (cause) => new MCodeCli.MCodeError({ operation: "repository", reason: "failed", cause }),
        ),
      ));
    const parsed = remote
      ? /^(?:git@git\.sankuai\.com:|(?:ssh|https?):\/\/(?:git@)?git\.sankuai\.com(?::\d+)?\/)(?:scm\/)?([^\s]+?)(?:\.git)?\/?$/u.exec(
          remote,
        )
      : null;
    if (!parsed?.[1] || !isRepositoryName(parsed[1]))
      return yield* new MCodeCli.MCodeError({
        operation: "repository",
        reason: "invalid-repository",
      });
    return parsed[1];
  });

  const readPr = Effect.fn("MCodeSourceControlProvider.readPr")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) {
    const link = parsePullRequestUrl(input.reference);
    const repo = link?.repository ?? (yield* repository(input));
    return yield* cli.json(
      {
        cwd: input.cwd,
        operation: "getChangeRequest",
        args: ["pr", "-R", repo, "view", link ? String(link.number) : input.reference, "--json"],
      },
      Json.PullRequest,
    );
  });

  const cloneUrls = (repo: typeof Json.Repository.Type) => ({
    nameWithOwner: repo.fullName,
    url: `http://git.sankuai.com/scm/${repo.fullName}.git`,
    sshUrl: repo.sshURL,
  });

  return SourceControlProvider.SourceControlProvider.of({
    kind: definition.kind,
    repositoryNameFromRemoteUrl: (url) =>
      SourceControlProvider.repositoryPathFromRemoteUrl(url)?.replace(/^scm\//u, "") ?? null,
    listChangeRequests: Effect.fn("MCodeSourceControlProvider.listChangeRequests")(
      function* (input) {
        const repo = yield* repository(input);
        const rows = yield* cli.json(
          {
            cwd: input.cwd,
            operation: "listChangeRequests",
            args: [
              "pr",
              "-R",
              repo,
              "list",
              "--source",
              SourceControlProvider.sourceBranch(input),
              "--state",
              input.state,
              "--limit",
              String(Math.min(input.limit ?? 100, 1000)),
              "--json",
            ],
          },
          Schema.Array(Json.PullRequest),
        );
        return rows.map(Json.changeRequest);
      },
      (effect, input) => effect.pipe(Effect.mapError(failure(input.cwd, "listChangeRequests"))),
    ),
    getChangeRequest: Effect.fn("MCodeSourceControlProvider.getChangeRequest")((input) =>
      readPr(input).pipe(
        Effect.map(Json.changeRequest),
        Effect.mapError(failure(input.cwd, "getChangeRequest")),
      ),
    ),
    createChangeRequest: Effect.fn("MCodeSourceControlProvider.createChangeRequest")(
      function* (input) {
        const repo = yield* repository(input);
        const head = SourceControlProvider.sourceBranch(input);
        const target = input.target?.repository ?? repo;
        if (
          target.toLowerCase() !== repo.toLowerCase() ||
          (input.source?.repository && input.source.repository.toLowerCase() !== repo.toLowerCase())
        )
          return yield* new MCodeCli.MCodeError({
            operation: "createChangeRequest",
            reason: "unsupported",
          });
        if (head === input.baseRefName)
          return yield* new MCodeCli.MCodeError({
            operation: "createChangeRequest",
            reason: "same-branch",
          });
        yield* cli.json(
          {
            cwd: input.cwd,
            operation: "targetBranch",
            args: ["repo", "-R", repo, "branch", "view", input.baseRefName, "--json"],
          },
          Json.Branch,
        );
        const existing = yield* cli.json(
          {
            cwd: input.cwd,
            operation: "existingChangeRequest",
            args: [
              "pr",
              "-R",
              repo,
              "list",
              "--source",
              head,
              "--target",
              input.baseRefName,
              "--state",
              "open",
              "--json",
            ],
          },
          Schema.Array(Json.PullRequest),
        );
        if (
          existing.some(
            (pr) =>
              pr.fromRef.repo.toLowerCase() === repo.toLowerCase() &&
              pr.toRef.branch === input.baseRefName,
          )
        )
          return;
        const settings = yield* cli.json(
          {
            cwd: input.cwd,
            operation: "repositorySettings",
            args: ["repo", "-R", repo, "settings", "--json"],
          },
          Json.RepositorySettings,
        );
        if (settings.requireIssueAssociated) {
          const branch = yield* cli.json(
            {
              cwd: input.cwd,
              operation: "sourceBranch",
              args: ["repo", "-R", repo, "branch", "view", head, "--json"],
            },
            Json.Branch,
          );
          if (!branch.issues?.length)
            return yield* new MCodeCli.MCodeError({
              operation: "createChangeRequest",
              reason: "issue-required",
            });
        }
        const candidates = yield* cli.json(
          {
            cwd: input.cwd,
            operation: "reviewerCandidates",
            args: ["repo", "-R", repo, "reviewers", "--target", input.baseRefName, "--json"],
          },
          Json.Reviewers,
        );
        let reviewers = "candidates" in candidates ? candidates.candidates : candidates;
        if (!reviewers.length) {
          const defaults = yield* cli.json(
            {
              cwd: input.cwd,
              operation: "defaultReviewers",
              args: ["repo", "-R", repo, "reviewers", "--json"],
            },
            Json.Reviewers,
          );
          reviewers = "candidates" in defaults ? defaults.candidates : defaults;
        }
        const body = yield* fileSystem
          .readFileString(input.bodyFile)
          .pipe(
            Effect.mapError(
              (cause) =>
                new MCodeCli.MCodeError({ operation: "readBody", reason: "failed", cause }),
            ),
          );
        yield* cli.json(
          {
            cwd: input.cwd,
            operation: "createChangeRequest",
            args: [
              "pr",
              "-R",
              repo,
              "create",
              "--title",
              input.title,
              "--body",
              body,
              "--head",
              head,
              "--base",
              input.baseRefName,
              ...[...new Set(reviewers.map((user) => user.mis).filter(Boolean))].flatMap((mis) => [
                "--reviewer",
                mis,
              ]),
              "--json",
            ],
          },
          Json.PullRequest,
        );
      },
      (effect, input) => effect.pipe(Effect.mapError(failure(input.cwd, "createChangeRequest"))),
    ),
    getRepositoryCloneUrls: Effect.fn("MCodeSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const repo = yield* repository(input);
        return cloneUrls(
          yield* cli.json(
            {
              cwd: input.cwd,
              operation: "getRepository",
              args: ["repo", "-R", repo, "view", "--json"],
            },
            Json.Repository,
          ),
        );
      },
      (effect, input) => effect.pipe(Effect.mapError(failure(input.cwd, "getRepositoryCloneUrls"))),
    ),
    createRepository: Effect.fn("MCodeSourceControlProvider.createRepository")(
      function* (input) {
        const repo = yield* repository(input);
        return cloneUrls(
          yield* cli.json(
            {
              cwd: input.cwd,
              operation: "createRepository",
              args: [
                "repo",
                "create",
                repo,
                ...(input.visibility === "public" ? ["--public"] : []),
                "--json",
              ],
            },
            Json.Repository,
          ),
        );
      },
      (effect, input) => effect.pipe(Effect.mapError(failure(input.cwd, "createRepository"))),
    ),
    getDefaultBranch: Effect.fn("MCodeSourceControlProvider.getDefaultBranch")(
      function* (input) {
        const repo = yield* repository(input);
        return (yield* cli.json(
          {
            cwd: input.cwd,
            operation: "getDefaultBranch",
            args: ["repo", "-R", repo, "branch", "default", "--json"],
          },
          Json.Branch,
        )).name;
      },
      (effect, input) => effect.pipe(Effect.mapError(failure(input.cwd, "getDefaultBranch"))),
    ),
    checkoutChangeRequest: Effect.fn("MCodeSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const pr = yield* readPr(input);
        const operation = "MCodeSourceControlProvider.checkoutChangeRequest";
        const contextRepo = input.context ? yield* repository(input) : null;
        const remoteName =
          input.context && contextRepo?.toLowerCase() === pr.fromRef.repo.toLowerCase()
            ? input.context.remoteName
            : yield* host.git.ensureRemote({
                cwd: input.cwd,
                preferredName: "meituan",
                url: input.context?.remoteUrl.startsWith("http")
                  ? `http://git.sankuai.com/scm/${pr.fromRef.repo}.git`
                  : `ssh://git@git.sankuai.com/${pr.fromRef.repo}.git`,
              });
        const branch =
          pr.fromRef.repo.toLowerCase() === pr.toRef.repo.toLowerCase()
            ? pr.fromRef.branch
            : `pr-${pr.id}/${pr.fromRef.branch}`;
        const remoteBranch = { cwd: input.cwd, remoteName, remoteBranch: pr.fromRef.branch };
        const existing = yield* host.git.listLocalBranchNames(input.cwd);
        if (input.force !== true && !existing.includes(branch))
          yield* host.git.fetchRemoteBranch({ ...remoteBranch, localBranch: branch });
        else yield* host.git.fetchRemoteTrackingBranch(remoteBranch);
        if (input.force === true) {
          yield* host.git.execute({
            cwd: input.cwd,
            operation,
            args: [
              "checkout",
              "-B",
              branch,
              `refs/remotes/${remoteName}/${pr.fromRef.branch}`,
              "--",
            ],
          });
        }
        yield* host.git.setBranchUpstream({ ...remoteBranch, branch });
        yield* Effect.scoped(host.git.switchRef({ cwd: input.cwd, refName: branch }));
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new SourceControlProviderError({
                provider: definition.kind,
                cwd: input.cwd,
                operation: "checkoutChangeRequest",
                detail: "Could not check out the Meituan Code pull request.",
                cause,
              }),
          ),
        ),
    ),
  });
});

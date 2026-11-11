import { SourceControlProviderError, parseBranchIssueUrl } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import { parseGitRemoteHost } from "@t3tools/source-control-core/shared/definition";
import { definition } from "../shared/definition.ts";
import * as MCodeCli from "./MCodeCli.ts";

const Field = Schema.Struct({ displayValue: Schema.NullOr(Schema.String) });
const Detail = Schema.Struct({ name: Field, state: Field, description: Field });
const Branches = Schema.Struct({
  total: Schema.Number,
  items: Schema.Array(
    Schema.Struct({ id: Schema.Number, name: Schema.String, repoAddress: Schema.String }),
  ),
});
const Branch = Schema.Struct({
  issues: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        id: Schema.Union([Schema.String, Schema.Number]),
        name: Schema.String,
        state: Schema.String,
        link: Schema.String,
      }),
    ),
  ),
});

function repositoryKey(remote: string): string | null {
  const host = parseGitRemoteHost(remote);
  const repository = SourceControlProvider.repositoryPathFromRemoteUrl(remote);
  return host && repository
    ? definition.canonicalRepositoryKey(`${host.host}/${repository}`)
    : null;
}

export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const cli = yield* MCodeCli.MCodeCli;
  const run = Effect.fn("MCodeIssues.run")(function* (cwd: string, args: ReadonlyArray<string>) {
    return yield* host.process
      .run({
        cwd,
        command: "ones2",
        args,
        operation: "branchIssues",
        timeoutMs: 60_000,
        maxOutputBytes: 1_000_000,
        concurrency: { key: "mep-ones-cli", limit: 2 },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: definition.kind,
              cwd,
              operation: "branchIssues",
              detail:
                "MEP ONES requires ones2 on the server PATH and an authenticated MEP account.",
              cause,
            }),
        ),
      );
  });
  const json = <A>(stdout: string, schema: Schema.Codec<A, unknown, never, never>, cwd: string) =>
    // ones2 prints progress before the final JSON object even with --json.
    Schema.decodeEffect(Schema.fromJsonString(schema))(stdout.slice(stdout.indexOf("{"))).pipe(
      Effect.mapError(
        (cause) =>
          new SourceControlProviderError({
            provider: definition.kind,
            cwd,
            operation: "branchIssues",
            detail: "The MEP response could not be read.",
            cause,
          }),
      ),
    );
  return {
    branches: Effect.fn("MCodeIssues.branches")(function* (input) {
      const repository = repositoryKey(input.context.remoteUrl);
      if (!repository)
        return yield* new SourceControlProviderError({
          provider: definition.kind,
          cwd: input.cwd,
          operation: "branchIssues",
          detail: "Select a Meituan Code repository.",
        });
      const names: string[] = [];
      let page = 1;
      while (true) {
        const result = yield* run(input.cwd, [
          "branch",
          "list",
          "-i",
          input.issue.id,
          "--page",
          String(page),
          "--page-size",
          "100",
          "--json",
        ]);
        const branches = yield* json(result.stdout, Branches, input.cwd);
        names.push(
          ...branches.items
            .filter((branch) => repositoryKey(branch.repoAddress) === repository)
            .map((branch) => branch.name),
        );
        if (branches.items.length === 0 || page * 100 >= branches.total) return names;
        page++;
      }
    }),
    read: Effect.fn("MCodeIssues.read")(function* (input) {
      const result = yield* run(input.cwd, [
        "workitem-detail",
        "info",
        "--workitem",
        input.issue.id,
        "--space",
        input.issue.repository,
        "--json",
      ]);
      const detail = yield* json(result.stdout, Detail, input.cwd);
      return {
        title: detail.name.displayValue ?? input.issue.id,
        state: detail.state.displayValue ?? "",
        body: detail.description.displayValue ?? "",
        bodyFormat: "html" as const,
      };
    }),
    list: Effect.fn("MCodeIssues.list")(function* (input) {
      const repo = SourceControlProvider.repositoryPathFromRemoteUrl(
        input.context.remoteUrl,
      )?.replace(/^scm\//u, "");
      const result = yield* cli
        .json(
          {
            cwd: input.cwd,
            operation: "branchIssues",
            args: ["repo", "-R", repo ?? "", "branch", "view", input.branch, "--json"],
          },
          Branch,
        )
        .pipe(
          Effect.catchTags({
            MCodeError: (cause) =>
              cause.reason === "not-found" ? Effect.succeed({ issues: [] }) : Effect.fail(cause),
          }),
          Effect.mapError(
            (cause) =>
              new SourceControlProviderError({
                provider: definition.kind,
                cwd: input.cwd,
                operation: "branchIssues",
                detail: cause.message,
                cause,
              }),
          ),
        );
      return (result.issues ?? []).flatMap((item) => {
        const ref = parseBranchIssueUrl(item.link);
        return ref
          ? [{ ...ref, title: item.name, state: item.state, association: "remote" as const }]
          : [];
      });
    }),
    update: Effect.fn("MCodeIssues.update")(function* (input) {
      const repo = SourceControlProvider.repositoryPathFromRemoteUrl(
        input.context.remoteUrl,
      )?.replace(/^scm\//u, "");
      const repository = repositoryKey(input.context.remoteUrl);
      if (!repo || !repository)
        return yield* new SourceControlProviderError({
          provider: definition.kind,
          cwd: input.cwd,
          operation: "branchIssues",
          detail: "Select a Meituan Code repository.",
        });
      if (input.action === "associate") {
        yield* run(input.cwd, [
          "branch",
          "associate",
          "-i",
          input.issue.id,
          "-s",
          input.issue.repository,
          "--repo",
          `ssh://git@git.sankuai.com/${repo}.git`,
          "--branch-name",
          input.branch,
          "--yes",
          "--json",
        ]);
        return;
      }
      let page = 1;
      while (true) {
        const result = yield* run(input.cwd, [
          "branch",
          "list",
          "-i",
          input.issue.id,
          "--page",
          String(page),
          "--page-size",
          "100",
          "--json",
        ]);
        const branches = yield* json(result.stdout, Branches, input.cwd);
        const matches = branches.items.filter(
          (item) => item.name === input.branch && repositoryKey(item.repoAddress) === repository,
        );
        for (const branch of matches)
          yield* run(input.cwd, [
            "branch",
            "disassociate",
            "-i",
            input.issue.id,
            "-s",
            input.issue.repository,
            "--branch-id",
            String(branch.id),
            "--yes",
            "--json",
          ]);
        if (matches.length > 0 || page * 100 >= branches.total || branches.items.length === 0)
          return;
        page++;
      }
    }),
  } satisfies NonNullable<SourceControlProvider.SourceControlProvider["Service"]["issues"]>;
});

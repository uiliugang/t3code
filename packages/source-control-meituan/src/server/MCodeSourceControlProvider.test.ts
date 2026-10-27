import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as TestHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as MCodeCli from "./MCodeCli.ts";
import * as Provider from "./MCodeSourceControlProvider.ts";
import { pullRequest } from "./mcodeFixtures.ts";
import { definition } from "../shared/definition.ts";

const context = {
  provider: { kind: definition.kind, name: "Meituan Code", baseUrl: "https://git.sankuai.com" },
  remoteName: "origin",
  remoteUrl: "ssh://git@git.sankuai.com/team/service.git",
};
const createInput = {
  cwd: "/repo",
  context,
  headSelector: "feature/service",
  baseRefName: "master",
  title: "Title",
  bodyFile: "/body.md",
};

const layerFor = (
  run: SourceControlHost.SourceControlHost["Service"]["process"]["run"],
  git: TestHost.TestSourceControlHostOptions["git"] = {},
) =>
  Layer.mergeAll(
    MCodeCli.layer,
    FileSystem.layerNoop({
      readFileString: () => Effect.succeed("Body with `code` and $(literal)\nSecond line"),
    }),
  ).pipe(Layer.provideMerge(TestHost.layer({ process: { run }, git })));

describe("Meituan source control", () => {
  it.effect("checks out the source branch with its upstream so edits can update the same PR", () =>
    Effect.gen(function* () {
      const fetches: Array<{ remoteName: string; remoteBranch: string; localBranch: string }> = [];
      const upstreams: Array<{ remoteName: string; remoteBranch: string; branch: string }> = [];
      const switches: string[] = [];
      const provider = yield* Provider.make.pipe(
        Effect.provide(
          layerFor(() => Effect.succeed(TestHost.processOutput(JSON.stringify(pullRequest))), {
            listLocalBranchNames: () => Effect.succeed([]),
            fetchRemoteBranch: (input) => {
              fetches.push(input);
              return Effect.void;
            },
            setBranchUpstream: (input) => {
              upstreams.push(input);
              return Effect.void;
            },
            switchRef: (input) => {
              switches.push(input.refName);
              return Effect.succeed({ refName: input.refName });
            },
          }),
        ),
      );
      yield* provider.checkoutChangeRequest({ cwd: "/repo", context, reference: "22" });
      expect(fetches).toMatchObject([
        { remoteName: "origin", remoteBranch: "feature/service", localBranch: "feature/service" },
      ]);
      expect(upstreams).toMatchObject([
        { remoteName: "origin", remoteBranch: "feature/service", branch: "feature/service" },
      ]);
      expect(switches).toEqual(["feature/service"]);
    }),
  );

  it.effect("uses actual CLI list flags and maps draft PRs", () =>
    Effect.gen(function* () {
      const calls: ReadonlyArray<string>[] = [];
      const provider = yield* Provider.make.pipe(
        Effect.provide(
          layerFor((input) => {
            calls.push(input.args);
            return Effect.succeed(
              TestHost.processOutput(JSON.stringify([{ ...pullRequest, state: "DRAFT" }])),
            );
          }),
        ),
      );
      const rows = yield* provider.listChangeRequests({
        cwd: "/repo",
        context,
        headSelector: "feature/service",
        state: "open",
      });
      expect(calls).toEqual([
        [
          "pr",
          "-R",
          "team/service",
          "list",
          "--source",
          "feature/service",
          "--state",
          "open",
          "--limit",
          "100",
          "--json",
        ],
      ]);
      expect(rows[0]).toMatchObject({ state: "open", isDraft: true, provider: "meituan" });
    }),
  );

  it.effect("blocks creation without required ONES binding before any write", () =>
    Effect.gen(function* () {
      const calls: ReadonlyArray<string>[] = [];
      const provider = yield* Provider.make.pipe(
        Effect.provide(
          layerFor((input) => {
            calls.push(input.args);
            const response = input.args.includes("list")
              ? []
              : input.args.includes("settings")
                ? { requireIssueAssociated: true }
                : { name: "master", issues: [] };
            return Effect.succeed(TestHost.processOutput(JSON.stringify(response)));
          }),
        ),
      );
      const result = yield* provider.createChangeRequest(createInput).pipe(Effect.result);
      expect(Result.isFailure(result) && result.failure.detail).toContain("ONES");
      expect(calls.some((args) => args.includes("create"))).toBe(false);
    }),
  );

  it.effect.each([false, true])(
    "preserves reviewers and literal PR bodies (fallback: %s)",
    (fallback) =>
      Effect.gen(function* () {
        const calls: ReadonlyArray<string>[] = [];
        const provider = yield* Provider.make.pipe(
          Effect.provide(
            layerFor((input) => {
              calls.push(input.args);
              const response = input.args.includes("list")
                ? []
                : input.args.includes("settings")
                  ? { requireIssueAssociated: true }
                  : input.args.includes("create")
                    ? pullRequest
                    : input.args.includes("reviewers")
                      ? input.args.includes("--target")
                        ? { candidates: fallback ? [] : [{ mis: "reviewer", name: "Reviewer" }] }
                        : [{ mis: "reviewer", name: "Reviewer" }]
                      : { name: "master", issues: [{ id: "123" }] };
              return Effect.succeed(TestHost.processOutput(JSON.stringify(response)));
            }),
          ),
        );
        yield* provider.createChangeRequest(createInput);
        const create = calls.find((args) => args.includes("create"));
        expect(create).toContain("Body with `code` and $(literal)\nSecond line");
        expect(create).not.toContain("--no-default-reviewers");
        expect(create).toContain("--reviewer");
        expect(create).toContain("reviewer");
      }),
  );

  it.effect("reuses an existing source-to-target PR without writing another", () =>
    Effect.gen(function* () {
      const calls: ReadonlyArray<string>[] = [];
      const provider = yield* Provider.make.pipe(
        Effect.provide(
          layerFor((input) => {
            calls.push(input.args);
            return Effect.succeed(
              TestHost.processOutput(
                JSON.stringify(input.args.includes("list") ? [pullRequest] : { name: "master" }),
              ),
            );
          }),
        ),
      );
      yield* provider.createChangeRequest(createInput);
      expect(calls).toHaveLength(2);
    }),
  );

  it.effect("rejects equal branches before running the CLI", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.make.pipe(
        Effect.provide(layerFor(() => Effect.die("Unexpected command"))),
      );
      const result = yield* provider
        .createChangeRequest({ ...createInput, headSelector: "master" })
        .pipe(Effect.result);
      expect(Result.isFailure(result) && result.failure.detail).toContain("must differ");
    }),
  );
});

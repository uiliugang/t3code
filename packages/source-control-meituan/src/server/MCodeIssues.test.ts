import { describe, expect, it } from "@effect/vitest";
import { SourceControlProviderKind, parseBranchIssueUrl } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as MCodeCli from "./MCodeCli.ts";
import * as Issues from "./MCodeIssues.ts";

const cwd = "/repo";
const context = {
  provider: {
    kind: SourceControlProviderKind.make("meituan"),
    name: "Meituan Code",
    baseUrl: "https://git.sankuai.com",
  },
  remoteName: "origin",
  remoteUrl: "ssh://git@git.sankuai.com/acme/app.git",
};
const ref = parseBranchIssueUrl(
  "https://mep.sankuai.com/app/ones/space/123/workItem/requirement/detail/456",
)!;

describe("MEP issue adapter", () => {
  it.effect("reads work item fields and existing native branch associations", () =>
    Effect.gen(function* () {
      const issues = yield* Issues.make;
      expect(yield* issues.read({ cwd, issue: ref })).toEqual({
        title: "Improve search",
        state: "In progress",
        body: "<p>Details</p>",
        bodyFormat: "html",
      });
      expect(yield* issues.list({ cwd, branch: "feature/search", context })).toEqual([
        { ...ref, title: "Improve search", state: "In progress", association: "remote" },
      ]);
    }).pipe(
      Effect.provide(
        MCodeCli.layer.pipe(
          Layer.provideMerge(
            TestHost.layer({
              process: {
                run: (input) =>
                  Effect.succeed(
                    TestHost.processOutput(
                      JSON.stringify(
                        input.command === "ones2"
                          ? {
                              name: { displayValue: "Improve search" },
                              state: { displayValue: "In progress" },
                              description: { displayValue: "<p>Details</p>" },
                            }
                          : {
                              issues: [
                                {
                                  id: "456",
                                  name: "Improve search",
                                  state: "In progress",
                                  link: ref.url,
                                },
                              ],
                            },
                      ),
                    ),
                  ),
              },
            }),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "unlinks only the exact branch in this repository and supplies noninteractive CLI flags",
    () =>
      Effect.gen(function* () {
        const calls: ReadonlyArray<string>[] = [];
        const issues = yield* Issues.make.pipe(
          Effect.provide(
            MCodeCli.layer.pipe(
              Layer.provideMerge(
                TestHost.layer({
                  process: {
                    run: (input) => {
                      calls.push(input.args);
                      return Effect.succeed(
                        TestHost.processOutput(
                          input.args.includes("list")
                            ? `Progress\n${JSON.stringify({
                                total: 4,
                                items: [
                                  {
                                    id: 4,
                                    name: "feature/search",
                                    repoAddress: "ssh://git@other.example/acme/app.git",
                                  },
                                  {
                                    id: 1,
                                    name: "feature/search",
                                    repoAddress: "ssh://git@git.sankuai.com/other/app.git",
                                  },
                                  { id: 2, name: "feature/other", repoAddress: context.remoteUrl },
                                  { id: 3, name: "feature/search", repoAddress: context.remoteUrl },
                                ],
                              })}`
                            : "Success",
                        ),
                      );
                    },
                  },
                }),
              ),
            ),
          ),
        );
        yield* issues.update({
          cwd,
          branch: "feature/search",
          context,
          issue: ref,
          action: "associate",
        });
        yield* issues.update({
          cwd,
          branch: "feature/search",
          context,
          issue: ref,
          action: "disassociate",
        });
        expect(calls[0]).toEqual([
          "branch",
          "associate",
          "-i",
          "456",
          "-s",
          "123",
          "--repo",
          context.remoteUrl,
          "--branch-name",
          "feature/search",
          "--yes",
          "--json",
        ]);
        expect(calls.filter((args) => args.includes("disassociate"))).toHaveLength(1);
        expect(calls[2]).toEqual([
          "branch",
          "disassociate",
          "-i",
          "456",
          "-s",
          "123",
          "--branch-id",
          "3",
          "--yes",
          "--json",
        ]);
        expect(yield* issues.branches({ cwd, context, issue: ref })).toEqual([
          "feature/other",
          "feature/search",
        ]);
      }),
  );
});

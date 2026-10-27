import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as TestHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as MCodeCli from "./MCodeCli.ts";
import * as Provider from "./MCodePullRequestProvider.ts";
import { pullRequest, repositoryRef } from "./mcodeFixtures.ts";
import { checksFromJson } from "./mcodeJson.ts";

const layerFor = (run: SourceControlHost.SourceControlHost["Service"]["process"]["run"]) =>
  MCodeCli.layer.pipe(Layer.provide(TestHost.layer({ process: { run } })));

describe("Meituan pull requests", () => {
  it("does not treat cached offline authentication as verified", () => {
    expect(
      MCodeCli.parseMCodeAuth(
        TestHost.processOutput("Logged in to http://git.sankuai.com as user (via CLI, offline)"),
      ).status,
    ).toBe("unknown");
    expect(
      MCodeCli.parseMCodeAuth(
        TestHost.processOutput("Logged in to http://git.sankuai.com as user (via CLI)"),
      ).status,
    ).toBe("authenticated");
  });

  it("keeps unrecognized checks pending and maps the actual CLI check format", () => {
    const checks = checksFromJson({
      statusChecks: [
        { name: "Build", state: "SUCCESS", description: "done", link: "https://ci.example/build" },
      ],
      mergeChecks: [{ name: "Approval", state: "UNRECOGNIZED", description: "", link: "" }],
    });
    expect(checks.map((check) => check.status)).toEqual(["success", "pending"]);
    expect(checksFromJson({ statusChecks: [], mergeChecks: [] })).toEqual([]);
  });

  it.effect.each(["approve", "request-changes"] as const)(
    "blocks self %s at execution",
    (verdict) =>
      Effect.gen(function* () {
        const writes: ReadonlyArray<string>[] = [];
        const provider = yield* Provider.make.pipe(
          Effect.provide(
            layerFor((input) => {
              if (input.args[0] === "auth")
                return Effect.succeed(
                  TestHost.processOutput(
                    "Logged in to https://git.sankuai.com as AUTHOR (via CLI)",
                  ),
                );
              if (input.args.includes("view"))
                return Effect.succeed(TestHost.processOutput(JSON.stringify(pullRequest)));
              writes.push(input.args);
              return Effect.succeed(TestHost.processOutput(""));
            }),
          ),
        );
        const result = yield* provider
          .submitReview({ ...repositoryRef, verdict, body: "Review", comments: [] })
          .pipe(Effect.result);
        expect(Result.isFailure(result) && result.failure.detail).toContain("own pull requests");
        expect(writes).toEqual([]);
      }),
  );

  it.effect("uses CLI review flags for another author's PR", () =>
    Effect.gen(function* () {
      const writes: ReadonlyArray<string>[] = [];
      const provider = yield* Provider.make.pipe(
        Effect.provide(
          layerFor((input) => {
            if (input.args[0] === "auth")
              return Effect.succeed(
                TestHost.processOutput(
                  "Logged in to https://git.sankuai.com as reviewer (via CLI)",
                ),
              );
            if (input.args.includes("view"))
              return Effect.succeed(TestHost.processOutput(JSON.stringify(pullRequest)));
            writes.push(input.args);
            return Effect.succeed(TestHost.processOutput(""));
          }),
        ),
      );
      yield* provider.submitReview({
        ...repositoryRef,
        verdict: "approve",
        body: "",
        comments: [],
      });
      expect(writes).toEqual([["pr", "-R", "team/service", "review", "22", "--approve"]]);
    }),
  );

  it.effect("uses assignment IDs for resolution and refuses AI comment IDs", () =>
    Effect.gen(function* () {
      const writes: ReadonlyArray<string>[] = [];
      const provider = yield* Provider.make.pipe(
        Effect.provide(
          layerFor((input) => {
            writes.push(input.args);
            return Effect.succeed(TestHost.processOutput(""));
          }),
        ),
      );
      yield* provider.setThreadResolution({
        ...repositoryRef,
        threadId: "human:123",
        resolved: true,
      });
      const result = yield* provider
        .setThreadResolution({ ...repositoryRef, threadId: "ai:123", resolved: true })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(writes).toEqual([["pr", "-R", "team/service", "resolve", "22", "123"]]);
    }),
  );

  it.effect("rejects other hosts before sending a command", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.make.pipe(
        Effect.provide(layerFor(() => Effect.die("Unexpected command"))),
      );
      const result = yield* provider
        .comment({ ...repositoryRef, host: "github.com", body: "text" })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect("keeps partial check failures pending even when the returned checks pass", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.make.pipe(
        Effect.provide(
          layerFor((input) => {
            if (input.args.includes("view"))
              return Effect.succeed(TestHost.processOutput(JSON.stringify(pullRequest)));
            expect(input.args).toContain("--verbose");
            return Effect.succeed(
              TestHost.processOutput(
                JSON.stringify({
                  statusChecks: [{ name: "Build", state: "SUCCESS", description: "", link: "" }],
                  mergeChecks: [],
                }),
                { stderr: "[DEBUG] merge-status request failed: unavailable\n" },
              ),
            );
          }),
        ),
      );
      const result = yield* provider.getChangeRequestChecks!(repositoryRef);
      expect(result.checks.map((check) => check.status)).toEqual(["success", "pending"]);
    }),
  );

  it.effect("loads the changed file count from the CLI diff", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.make.pipe(
        Effect.provide(
          layerFor((input) => {
            if (input.args.includes("view"))
              return Effect.succeed(TestHost.processOutput(JSON.stringify(pullRequest)));
            if (input.args[0] === "auth")
              return Effect.succeed(
                TestHost.processOutput("Logged in to http://git.sankuai.com as reviewer (via CLI)"),
              );
            if (input.args.includes("diff")) {
              expect(input.args).toContain("--name-only");
              return Effect.succeed(TestHost.processOutput("src/one.ts\nsrc/two.ts\n"));
            }
            return Effect.succeed(
              TestHost.processOutput(JSON.stringify({ statusChecks: [], mergeChecks: [] })),
            );
          }),
        ),
      );
      const result = yield* provider.getChangeRequest(repositoryRef);
      expect(result.changedFiles).toBe(2);
      expect(result.viewerPermissions?.verdicts).toContain("approve");
    }),
  );

  it.effect("reports malformed CLI JSON instead of an empty PR list", () =>
    Effect.gen(function* () {
      const provider = yield* Provider.make.pipe(
        Effect.provide(layerFor(() => Effect.succeed(TestHost.processOutput("not json")))),
      );
      const result = yield* provider
        .listChangeRequests({
          ...repositoryRef,
          state: "open",
          involvement: "all",
          viewer: "reviewer",
          limit: 20,
        })
        .pipe(Effect.result);
      expect(Result.isFailure(result) && result.failure.detail).toContain("unreadable response");
    }),
  );

  it.effect("advances pagination by raw rows even when review filtering removes them", () =>
    Effect.gen(function* () {
      const rows = [
        pullRequest,
        { ...pullRequest, id: 23, reviewers: [] },
        { ...pullRequest, id: 24 },
      ];
      const provider = yield* Provider.make.pipe(
        Effect.provide(
          layerFor(() => Effect.succeed(TestHost.processOutput(JSON.stringify(rows)))),
        ),
      );
      const page = yield* provider.listChangeRequests({
        ...repositoryRef,
        state: "open",
        involvement: "reviewing",
        viewer: "reviewer",
        limit: 2,
      });
      expect(page.items.map((pr) => pr.number)).toEqual([22]);
      expect(page.cursorAdvance).toBe(2);
      expect(page.continues).toBe(true);
    }),
  );
});

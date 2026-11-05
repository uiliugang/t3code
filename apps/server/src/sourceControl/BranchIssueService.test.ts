import { describe, expect, it } from "@effect/vitest";
import {
  BranchIssueError,
  SourceControlProviderKind,
  SourceControlProviderError,
  type BranchIssueDetail,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Providers from "./SourceControlProviderRegistry.ts";
import * as Service from "./BranchIssueService.ts";
import type * as Provider from "@t3tools/source-control-core/server/SourceControlProvider";

const first = "https://github.com/acme/app/issues/1";
const second = "https://github.com/acme/app/issues/2";
const target = { cwd: "/repo", branch: "feature/issues" };
const detail: BranchIssueDetail = {
  title: "Fix the thing",
  state: "open",
  body: "Description",
  bodyFormat: "markdown",
};

function setup(
  options: {
    failUrl?: string;
    remote?: boolean;
    failUnlink?: boolean;
    provider?: "github" | "meituan";
    published?: boolean;
    remotePublished?: boolean;
  } = {},
) {
  const kind = SourceControlProviderKind.make(options.provider ?? "github");
  const config = new Map<string, string>();
  const writes: string[] = [];
  const capability: NonNullable<Provider.SourceControlProvider["Service"]["issues"]> = {
    ...(options.published === false && !options.remotePublished
      ? { list: () => Effect.die("Unpublished branches must not query remote issues") }
      : {}),
    read: ({ cwd, issue }) =>
      issue.url === options.failUrl
        ? Effect.fail(
            new SourceControlProviderError({
              provider: kind,
              cwd,
              operation: "readIssue",
              detail: "Unavailable",
            }),
          )
        : Effect.succeed(detail),
    ...(options.remote
      ? {
          update: ({ issue, action }) =>
            action === "disassociate" && options.failUnlink
              ? Effect.fail(
                  new SourceControlProviderError({
                    provider: kind,
                    cwd: target.cwd,
                    operation: "update",
                    detail: "Workflow restricted",
                  }),
                )
              : Effect.sync(() => {
                  writes.push(issue.url);
                }),
        }
      : {}),
  };
  const layer = Service.layer.pipe(
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(Git.GitVcsDriver)({
        listLocalBranchNames: () => Effect.succeed([target.branch, "unlinked"]),
        remoteBranchExists: () => Effect.succeed(options.published ?? true),
        execute: () =>
          Effect.succeed({
            stdout: options.remotePublished ? "abc\trefs/heads/feature/issues\n" : "",
            stderr: "",
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        readConfigValue: (_cwd, key) => Effect.sync(() => config.get(key) ?? null),
        writeConfigValue: ({ key, value }) =>
          Effect.sync(() => {
            config.set(key, value);
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(Providers.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
        resolveHandle: ({ cwd }) =>
          Effect.succeed({
            provider: {
              kind,
              issues: capability,
            } as Provider.SourceControlProvider["Service"],
            context: {
              provider: {
                kind,
                name: "GitHub",
                baseUrl: "https://github.com",
              },
              remoteName: "origin",
              remoteUrl:
                cwd === "/other" ? "https://github.com/other/app" : "git@github.com:acme/app.git",
            },
          }),
      }),
    ),
  );
  return { layer, config, writes };
}

describe("branch issue associations", () => {
  it.effect("recognizes a published branch missing from narrow local tracking refs", () =>
    Effect.gen(function* () {
      const service = yield* Service.BranchIssueService;
      expect(yield* service.list(target)).toMatchObject({ published: true });
      yield* service.update({ ...target, action: "associate", urls: [first] });
    }).pipe(Effect.provide(setup({ published: false, remotePublished: true }).layer)),
  );
  it.effect("does not query or associate an unpublished branch", () =>
    Effect.gen(function* () {
      const service = yield* Service.BranchIssueService;
      expect(yield* service.list(target)).toMatchObject({ published: false, issues: [] });
      const error = yield* service
        .update({ ...target, action: "associate", urls: [first] })
        .pipe(Effect.flip);
      expect(error.reason).toBe("unpublished");
    }).pipe(Effect.provide(setup({ published: false }).layer)),
  );
  it.effect("retains a MEP association when its workflow refuses unlinking", () =>
    Effect.gen(function* () {
      const url = "https://mep.sankuai.com/app/ones/space/123/workItem/requirement/detail/456";
      const service = yield* Service.BranchIssueService;
      yield* service.update({ ...target, action: "associate", urls: [url] });
      const error = yield* service
        .update({ ...target, action: "disassociate", urls: [url] })
        .pipe(Effect.flip);
      expect(error.reason).toBe("unlink-failed");
      expect((yield* service.list(target)).issues.map((issue) => issue.url)).toEqual([url]);
    }).pipe(Effect.provide(setup({ remote: true, provider: "meituan", failUnlink: true }).layer)),
  );
  it.effect(
    "deduplicates canonical links, shares checkouts, isolates branches and repositories, and unlinks",
    () =>
      Effect.gen(function* () {
        const fixture = setup();
        yield* Effect.gen(function* () {
          const service = yield* Service.BranchIssueService;
          yield* service.update({
            ...target,
            action: "associate",
            urls: [first, `${first}?view=1`],
          });
          expect(
            (yield* service.list({ ...target, cwd: "/worktree" })).issues.map((issue) => issue.url),
          ).toEqual([first]);
          expect((yield* service.list({ ...target, branch: "another" })).issues).toEqual([]);
          expect((yield* service.list({ ...target, cwd: "/other" })).issues).toEqual([]);
          expect(yield* service.branches({ cwd: target.cwd, url: first })).toEqual([
            { name: target.branch, linked: true },
            { name: "unlinked", linked: false },
          ]);
          yield* service.update({ ...target, action: "disassociate", urls: [first] });
          expect((yield* service.list(target)).issues).toEqual([]);
          expect(
            (yield* service.branches({ cwd: target.cwd, url: first })).every(
              (branch) => !branch.linked,
            ),
          ).toBe(true);
          expect(fixture.writes).toEqual([]);
          expect([...fixture.config.values()].join()).not.toContain(detail.body);
        }).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect("rejects multiple issues before writing and preserves the existing association", () =>
    Effect.gen(function* () {
      const fixture = setup({ failUrl: second });
      yield* Effect.gen(function* () {
        const service = yield* Service.BranchIssueService;
        const invalid = yield* service
          .update({
            ...target,
            action: "associate",
            urls: [first, "https://mep.sankuai.com/app/ones/space/1/workItem/devtask/detail/2"],
          })
          .pipe(Effect.flip);
        expect(invalid).toBeInstanceOf(BranchIssueError);
        expect(fixture.config.size).toBe(0);
        const limitError = yield* service
          .update({ ...target, action: "associate", urls: [first, second] })
          .pipe(Effect.flip);
        expect(limitError.reason).toBe("issue-limit");
        expect(fixture.config.size).toBe(0);
        yield* service.update({ ...target, action: "associate", urls: [first] });
        expect(
          (yield* service
            .update({ ...target, action: "associate", urls: [second] })
            .pipe(Effect.flip)).reason,
        ).toBe("issue-limit");
        expect((yield* service.list(target)).issues.map((issue) => issue.url)).toEqual([first]);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("allows only one simultaneous association", () =>
    Effect.gen(function* () {
      const service = yield* Service.BranchIssueService;
      const results = yield* Effect.forEach(
        [first, second],
        (url) =>
          service.update({ ...target, action: "associate", urls: [url] }).pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect((yield* service.list(target)).issues).toHaveLength(1);
    }).pipe(Effect.provide(setup().layer)),
  );

  it.effect("performs remote association and disassociation through the provider", () =>
    Effect.gen(function* () {
      const fixture = setup({ remote: true });
      yield* Effect.gen(function* () {
        const service = yield* Service.BranchIssueService;
        yield* service.update({ ...target, action: "associate", urls: [first] });
        yield* service.update({ ...target, action: "associate", urls: [first] });
        expect((yield* service.list(target)).issues[0]?.association).toBe("remote");
        yield* service.update({ ...target, action: "disassociate", urls: [first] });
        expect((yield* service.list(target)).issues).toEqual([]);
        expect(fixture.writes).toEqual([first, first]);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
});

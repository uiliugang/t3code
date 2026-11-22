import { assert, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Executor from "./DaxiangApprovalExecutor.ts";
import { parseApprovalLink, type ParsedApprovalTarget } from "./daxiangApprovalLinks.ts";

const behavior = {
  autoApprovePullRequest: true,
  pullRequestComment: "LGTM",
  autoApproveMcm: true,
  mcmApproveComment: "自动审批通过",
};

function target(url: string): ParsedApprovalTarget {
  const parsed = parseApprovalLink(url);
  if (!parsed) throw new Error(`Invalid test URL: ${url}`);
  return parsed;
}

type Reply =
  | string
  | {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly code?: number;
      readonly timedOut?: boolean;
    };

function testLayer(
  calls: string[],
  reply: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Reply | Effect.Effect<Reply, ProcessRunner.ProcessRunError>,
  baseDir?: string,
) {
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
    Effect.suspend(() => {
      const { command, args } = input;
      calls.push([command, ...args].join(" "));
      const result = reply(command, args);
      return Effect.isEffect(result) ? result : Effect.succeed(result);
    }).pipe(
      Effect.map((result) => {
        const normalized = typeof result === "string" ? { stdout: result } : result;
        return {
          stdout: normalized.stdout ?? "",
          stderr: normalized.stderr ?? "",
          code: ChildProcessSpawner.ExitCode(normalized.code ?? 0),
          timedOut: normalized.timedOut ?? false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
    );
  return Executor.layer.pipe(
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })),
    Layer.provide(Layer.succeed(HostProcess.Environment, { PATH: "" })),
    Layer.provide(
      ServerConfig.ServerConfig.layerTest("/tmp", baseDir ?? { prefix: "daxiang-approval-test-" }),
    ),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodePath.layer),
  );
}

const prUrl = "https://dev.sankuai.com/code/repo-detail/group/repo/pr/123/diff";
const planUrl = "https://mcm.mws.sankuai.com/#/mine/plan/detail/456";
const eventUrl = "https://mcm.mws.sankuai.com/#/process-center/detail/789/info";

it.effect("adds the reviewer, posts LGTM once, then approves the PR at its current commit", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    let approved = false;
    const layer = testLayer(calls, (command, args) => {
      if (command === "code-cli" && args[0] === "auth") {
        return "Logged in to http://git.sankuai.com as liugang59 (https://dev.sankuai.com)";
      }
      if (command === "code-cli" && args[0] === "pr" && args[3] === "view") {
        return JSON.stringify({
          state: "OPEN",
          author: { mis: "author01" },
          fromRef: { commitId: "abc123" },
          reviewers: approved ? [{ mis: "liugang59", approved: true }] : [],
        });
      }
      if (command === "code-cli" && args[3] === "comments") return "[]";
      if (command === "code-cli" && args[3] === "review") {
        approved = true;
      }
      return "{}";
    });
    const result = yield* Executor.DaxiangApprovalExecutor.pipe(
      Effect.flatMap((service) => service.execute(target(prUrl), behavior)),
      Effect.provide(layer),
    );
    assert.strictEqual(result.outcome, "approved", result.detail ?? undefined);
    assert.strictEqual(result.key, "pr:group/repo#123@abc123");
    const commentIndex = calls.findIndex((command) => command.includes(" comment 123 "));
    const approveIndex = calls.findIndex((command) => command.includes(" review 123 --approve"));
    assert.isTrue(
      calls.some((command) => command.includes("add-reviewer 123 --reviewer liugang59")),
    );
    assert.isTrue(commentIndex >= 0);
    assert.isTrue(approveIndex > commentIndex);
  }),
);

it.effect(
  "retries an approval that never spawned without duplicate LGTM, but comments again on a new commit",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      let commitId = "abc123";
      let approveAttempts = 0;
      const layer = testLayer(calls, (command, args) => {
        if (command === "code-cli" && args[0] === "auth") {
          return "Logged in to http://git.sankuai.com as liugang59";
        }
        if (command === "code-cli" && args[3] === "view") {
          return JSON.stringify({
            state: "OPEN",
            author: { mis: "author01" },
            fromRef: { commitId },
            reviewers: approveAttempts > 1 ? [{ mis: "liugang59", approved: true }] : [],
          });
        }
        if (command === "code-cli" && args[3] === "review") {
          approveAttempts += 1;
          return approveAttempts === 1
            ? Effect.fail(
                new ProcessRunner.ProcessSpawnError({
                  command,
                  argumentCount: args.length,
                  cause: new Error("spawn failed before the CLI started"),
                }),
              )
            : "{}";
        }
        return "{}";
      });
      const service = yield* Executor.DaxiangApprovalExecutor.pipe(Effect.provide(layer));
      const first = yield* service.execute(target(prUrl), behavior);
      assert.strictEqual(first.outcome, "failed", first.detail ?? undefined);
      const second = yield* service.execute(target(prUrl), behavior);
      assert.strictEqual(second.outcome, "approved", second.detail ?? undefined);
      commitId = "def456";
      const third = yield* service.execute(target(prUrl), behavior);
      assert.strictEqual(third.outcome, "approved", third.detail ?? undefined);
      assert.strictEqual(calls.filter((command) => command.includes(" comment 123 ")).length, 2);
    }),
);

it.effect("never approves the author's own PR", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const layer = testLayer(calls, (command, args) => {
      if (command === "code-cli" && args[0] === "auth") {
        return "Logged in to http://git.sankuai.com as liugang59";
      }
      if (command === "code-cli" && args[3] === "view") {
        return JSON.stringify({
          state: "OPEN",
          author: { mis: "liugang59" },
          fromRef: { commitId: "abc123" },
          reviewers: [],
        });
      }
      return "[]";
    });
    const result = yield* Executor.DaxiangApprovalExecutor.pipe(
      Effect.flatMap((service) => service.execute(target(prUrl), behavior)),
      Effect.provide(layer),
    );
    assert.strictEqual(result.outcome, "skipped", result.detail ?? undefined);
    assert.isFalse(calls.some((command) => command.includes("--approve")));
    assert.isFalse(calls.some((command) => command.includes(" comment ")));
  }),
);

it.effect("approves an MCM plan only at the current level assigned to the viewer", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const layer = testLayer(calls, (command, args) => {
      if (command === "mcm" && args[0] === "user") return JSON.stringify({ mis: "liugang59" });
      if (command === "mcm" && args[0] === "plan" && args[1] === "detail") {
        return JSON.stringify({
          status: 1,
          approveLevel: 2,
          planApproves: [{ level: 2, status: 0, user: { mis: "liugang59" } }],
        });
      }
      return "{}";
    });
    const service = yield* Executor.DaxiangApprovalExecutor.pipe(Effect.provide(layer));
    const result = yield* service.execute(target(planUrl), behavior);
    assert.strictEqual(result.outcome, "approved", result.detail ?? undefined);
    const repeated = yield* service.execute(target(planUrl), behavior);
    assert.strictEqual(repeated.outcome, "skipped", repeated.detail ?? undefined);
    assert.strictEqual(calls.filter((command) => command.includes("plan approve 456")).length, 1);
    assert.isTrue(
      calls.some((command) =>
        command.includes("plan approve 456 --approve-level 2 --comment 自动审批通过 -y -f json"),
      ),
    );
  }),
);

it.effect("does not approve an MCM plan when the current level belongs to someone else", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const layer = testLayer(calls, (command, args) => {
      if (command === "mcm" && args[0] === "user") return JSON.stringify({ mis: "liugang59" });
      if (command === "mcm" && args[0] === "plan" && args[1] === "detail") {
        return JSON.stringify({
          status: 1,
          approveLevel: 3,
          planApproves: [{ level: 3, status: 0, user: { mis: "other01" } }],
        });
      }
      return "{}";
    });
    const result = yield* Executor.DaxiangApprovalExecutor.pipe(
      Effect.flatMap((service) => service.execute(target(planUrl), behavior)),
      Effect.provide(layer),
    );
    assert.strictEqual(result.outcome, "skipped", result.detail ?? undefined);
    assert.isFalse(calls.some((command) => command.includes("plan approve")));
  }),
);

it.effect("rejects empty MCM approval metadata instead of bypassing the viewer check", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const layer = testLayer(calls, (command, args) => {
      if (command === "mcm" && args[0] === "user") return JSON.stringify({ mis: "liugang59" });
      if (command === "mcm" && args[0] === "plan" && args[1] === "detail") {
        return JSON.stringify({ status: 1, approveLevel: 2, planApproves: [] });
      }
      return "{}";
    });
    const result = yield* Executor.DaxiangApprovalExecutor.pipe(
      Effect.flatMap((service) => service.execute(target(planUrl), behavior)),
      Effect.provide(layer),
    );
    assert.strictEqual(result.outcome, "skipped", result.detail ?? undefined);
    assert.isFalse(calls.some((command) => command.includes("plan approve")));
  }),
);

it.effect("never uses the production MCM CLI for a test-environment link", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const layer = testLayer(calls, () => "{}");
    const testTarget = target("https://mcm.mws-test.sankuai.com/#/mine/plan/detail/456");
    const result = yield* Executor.DaxiangApprovalExecutor.pipe(
      Effect.flatMap((service) => service.execute(testTarget, behavior)),
      Effect.provide(layer),
    );
    assert.strictEqual(result.outcome, "skipped", result.detail ?? undefined);
    assert.isFalse(calls.some((command) => command.includes("plan detail")));
    assert.isFalse(calls.some((command) => command.includes("plan approve")));
  }),
);

it.effect("accepts only MCM events that are still AUDITING", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const layer = testLayer(calls, (command, args) => {
      if (command === "mcm" && args[0] === "user") return JSON.stringify({ mis: "liugang59" });
      if (command === "mcm" && args[0] === "event" && args[1] === "list") {
        return JSON.stringify({ items: [{ id: 789 }] });
      }
      if (command === "mcm" && args[0] === "event" && args[1] === "get") {
        return JSON.stringify({ changeDetail: { status: "AUDITING" } });
      }
      return "{}";
    });
    const service = yield* Executor.DaxiangApprovalExecutor.pipe(Effect.provide(layer));
    const result = yield* service.execute(target(eventUrl), behavior);
    assert.strictEqual(result.outcome, "approved", result.detail ?? undefined);
    assert.strictEqual((yield* service.execute(target(eventUrl), behavior)).outcome, "skipped");
    assert.strictEqual(calls.filter((command) => command.includes("event accept 789")).length, 1);
    assert.isTrue(calls.some((command) => command.includes("event accept 789")));
  }),
);

it.effect("skips an MCM event that is not assigned to the current user", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const layer = testLayer(calls, (command, args) => {
      if (command === "mcm" && args[0] === "user") return JSON.stringify({ mis: "liugang59" });
      if (command === "mcm" && args[0] === "event" && args[1] === "list") {
        return JSON.stringify({ items: [{ id: 123 }] });
      }
      if (command === "mcm" && args[0] === "event" && args[1] === "get") {
        return JSON.stringify({ changeDetail: { status: "AUDITING" } });
      }
      return "{}";
    });
    const result = yield* Executor.DaxiangApprovalExecutor.pipe(
      Effect.flatMap((service) => service.execute(target(eventUrl), behavior)),
      Effect.provide(layer),
    );
    assert.strictEqual(result.outcome, "skipped", result.detail ?? undefined);
    assert.isFalse(calls.some((command) => command.includes("event accept")));
  }),
);

it.effect("skips draft pull requests and responses without a head commit", () =>
  Effect.gen(function* () {
    const draftCalls: string[] = [];
    const draftLayer = testLayer(draftCalls, (command, args) => {
      if (command === "code-cli" && args[0] === "auth") {
        return "Logged in to http://git.sankuai.com as liugang59";
      }
      if (command === "code-cli" && args[3] === "view") {
        return JSON.stringify({
          state: "DRAFT",
          author: { mis: "author01" },
          fromRef: { commitId: "abc123" },
          reviewers: [],
        });
      }
      return "{}";
    });
    const draft = yield* Executor.DaxiangApprovalExecutor.pipe(
      Effect.flatMap((service) => service.execute(target(prUrl), behavior)),
      Effect.provide(draftLayer),
    );
    assert.strictEqual(draft.outcome, "skipped", draft.detail ?? undefined);
    assert.isFalse(draftCalls.some((command) => command.includes("review 123 --approve")));

    const missingCalls: string[] = [];
    const missingLayer = testLayer(missingCalls, (command, args) => {
      if (command === "code-cli" && args[0] === "auth") {
        return "Logged in to http://git.sankuai.com as liugang59";
      }
      if (command === "code-cli" && args[3] === "view") {
        return JSON.stringify({
          state: "OPEN",
          author: { mis: "author01" },
          fromRef: {},
          reviewers: [],
        });
      }
      return "{}";
    });
    const missing = yield* Executor.DaxiangApprovalExecutor.pipe(
      Effect.flatMap((service) => service.execute(target(prUrl), behavior)),
      Effect.provide(missingLayer),
    );
    assert.strictEqual(missing.outcome, "skipped", missing.detail ?? undefined);
    assert.isFalse(missingCalls.some((command) => command.includes(" comment 123 ")));
    assert.isFalse(missingCalls.some((command) => command.includes("review 123 --approve")));
  }),
);

it.effect("does not approve a new PR head that arrives during the approval flow", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    let views = 0;
    const layer = testLayer(calls, (command, args) => {
      if (command === "code-cli" && args[0] === "auth") {
        return "Logged in to http://git.sankuai.com as liugang59";
      }
      if (command === "code-cli" && args[3] === "view") {
        views += 1;
        return JSON.stringify({
          state: "OPEN",
          author: { mis: "author01" },
          fromRef: { commitId: views === 1 ? "abc123" : "def456" },
          reviewers: [],
        });
      }
      return "{}";
    });
    const result = yield* Executor.DaxiangApprovalExecutor.pipe(
      Effect.flatMap((service) => service.execute(target(prUrl), behavior)),
      Effect.provide(layer),
    );
    assert.strictEqual(result.outcome, "skipped", result.detail ?? undefined);
    assert.strictEqual(result.key, "pr:group/repo#123@abc123");
    assert.isFalse(calls.some((command) => command.includes("review 123 --approve")));
  }),
);

it.effect("marks a changed PR head as unknown without withdrawing another review", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    let views = 0;
    const layer = testLayer(calls, (command, args) => {
      if (command === "code-cli" && args[0] === "auth") {
        return "Logged in to http://git.sankuai.com as liugang59";
      }
      if (command === "code-cli" && args[3] === "view") {
        views += 1;
        return JSON.stringify({
          state: "OPEN",
          author: { mis: "author01" },
          fromRef: { commitId: views <= 2 ? "abc123" : "def456" },
          reviewers: [],
        });
      }
      return "{}";
    });
    const result = yield* Executor.DaxiangApprovalExecutor.pipe(
      Effect.flatMap((service) => service.execute(target(prUrl), behavior)),
      Effect.provide(layer),
    );
    assert.strictEqual(result.outcome, "deliveryUnknown", result.detail ?? undefined);
    assert.isTrue(calls.some((command) => command.includes("review 123 --approve")));
    assert.isFalse(calls.some((command) => command.includes("review 123 --disapprove")));
  }),
);

it.effect("does not retry an unconfirmed PR approval after an executor restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "daxiang-pr-unknown-" });
      const calls: string[] = [];
      const reply = (command: string, args: ReadonlyArray<string>): Reply => {
        if (command === "code-cli" && args[0] === "auth") {
          return "Logged in to http://git.sankuai.com as liugang59";
        }
        if (command === "code-cli" && args[3] === "view") {
          return JSON.stringify({
            state: "OPEN",
            author: { mis: "author01" },
            fromRef: { commitId: "abc123" },
            reviewers: [],
          });
        }
        return "{}";
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = yield* Executor.DaxiangApprovalExecutor.pipe(
          Effect.flatMap((service) => service.execute(target(prUrl), behavior)),
          Effect.provide(testLayer(calls, reply, stateDir)),
        );
        assert.strictEqual(result.outcome, "deliveryUnknown", result.detail ?? undefined);
      }
      assert.strictEqual(
        calls.filter((command) => command.includes("review 123 --approve")).length,
        1,
      );
    }),
  ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("does not post LGTM again after a comment timeout, including after restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "daxiang-comment-unknown-" });
      const calls: string[] = [];
      const reply = (command: string, args: ReadonlyArray<string>): Reply => {
        if (command === "code-cli" && args[0] === "auth") {
          return "Logged in to http://git.sankuai.com as liugang59";
        }
        if (command === "code-cli" && args[3] === "view") {
          return JSON.stringify({
            state: "OPEN",
            author: { mis: "author01" },
            fromRef: { commitId: "abc123" },
            reviewers: [],
          });
        }
        if (command === "code-cli" && args[3] === "comment") return { timedOut: true };
        return "{}";
      };
      const service = yield* Executor.DaxiangApprovalExecutor.pipe(
        Effect.provide(testLayer(calls, reply, stateDir)),
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = yield* service.execute(target(prUrl), behavior);
        assert.strictEqual(result.outcome, "deliveryUnknown", result.detail ?? undefined);
      }
      const restarted = yield* Executor.DaxiangApprovalExecutor.pipe(
        Effect.flatMap((executor) => executor.execute(target(prUrl), behavior)),
        Effect.provide(testLayer(calls, reply, stateDir)),
      );
      assert.strictEqual(restarted.outcome, "deliveryUnknown", restarted.detail ?? undefined);
      assert.strictEqual(calls.filter((command) => command.includes(" comment 123 ")).length, 1);
      assert.isFalse(calls.some((command) => command.includes("review 123 --approve")));
    }),
  ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("does not treat a stale reviewer approval flag as approval of the current head", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const layer = testLayer(calls, (command, args) => {
      if (command === "code-cli" && args[0] === "auth") {
        return "Logged in to http://git.sankuai.com as liugang59";
      }
      if (command === "code-cli" && args[3] === "view") {
        return JSON.stringify({
          state: "OPEN",
          author: { mis: "author01" },
          fromRef: { commitId: "def456" },
          reviewers: [{ mis: "liugang59", approved: true }],
        });
      }
      return "{}";
    });
    const result = yield* Executor.DaxiangApprovalExecutor.pipe(
      Effect.flatMap((service) => service.execute(target(prUrl), behavior)),
      Effect.provide(layer),
    );
    assert.strictEqual(result.outcome, "approved", result.detail ?? undefined);
    assert.isTrue(calls.some((command) => command.includes("review 123 --approve")));
  }),
);

it.effect("marks a timed-out MCM approval as unknown instead of retrying the next level", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const layer = testLayer(calls, (command, args) => {
      if (command === "mcm" && args[0] === "user") return JSON.stringify({ mis: "liugang59" });
      if (command === "mcm" && args[0] === "plan" && args[1] === "detail") {
        return JSON.stringify({
          status: 1,
          approveLevel: 2,
          planApproves: [{ level: 2, status: 0, user: { mis: "liugang59" } }],
        });
      }
      if (command === "mcm" && args[0] === "plan" && args[1] === "approve") {
        return { timedOut: true };
      }
      return "{}";
    });
    const result = yield* Executor.DaxiangApprovalExecutor.pipe(
      Effect.flatMap((service) => service.execute(target(planUrl), behavior)),
      Effect.provide(layer),
    );
    assert.strictEqual(result.outcome, "deliveryUnknown", result.detail ?? undefined);
    assert.strictEqual(calls.filter((command) => command.includes("plan approve 456")).length, 1);
  }),
);

it.effect("finds an MCM event assigned beyond the first TODO page", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const layer = testLayer(calls, (command, args) => {
      if (command === "mcm" && args[0] === "user") return JSON.stringify({ mis: "liugang59" });
      if (command === "mcm" && args[0] === "event" && args[1] === "list") {
        const page = args[5];
        return JSON.stringify({
          items: page === "1" ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 789 }],
        });
      }
      if (command === "mcm" && args[0] === "event" && args[1] === "get") {
        return JSON.stringify({ changeDetail: { status: "AUDITING" } });
      }
      return "{}";
    });
    const result = yield* Executor.DaxiangApprovalExecutor.pipe(
      Effect.flatMap((service) => service.execute(target(eventUrl), behavior)),
      Effect.provide(layer),
    );
    assert.strictEqual(result.outcome, "approved", result.detail ?? undefined);
    assert.isTrue(calls.some((command) => command.includes("event list -t TODO -p 2")));
  }),
);

it.effect("deduplicates a second approval attempt for the same PR head before any mutation", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    let approved = false;
    const layer = testLayer(calls, (command, args) => {
      if (command === "code-cli" && args[0] === "auth") {
        return "Logged in to http://git.sankuai.com as liugang59";
      }
      if (command === "code-cli" && args[3] === "view") {
        return JSON.stringify({
          state: "OPEN",
          author: { mis: "author01" },
          fromRef: { commitId: "abc123" },
          reviewers: approved ? [{ mis: "liugang59", approved: true }] : [],
        });
      }
      if (command === "code-cli" && args[3] === "review") {
        approved = true;
      }
      return "{}";
    });
    const service = yield* Executor.DaxiangApprovalExecutor.pipe(Effect.provide(layer));
    const first = yield* service.execute(target(prUrl), behavior);
    assert.strictEqual(first.outcome, "approved", first.detail ?? undefined);
    const second = yield* service.execute(target(prUrl), behavior);
    assert.strictEqual(second.outcome, "skipped", second.detail ?? undefined);
    assert.strictEqual(
      calls.filter((command) => command.includes("review 123 --approve")).length,
      1,
    );
    assert.strictEqual(calls.filter((command) => command.includes(" comment 123 ")).length, 1);
  }),
);

it.effect("marks an approval as unknown when the confirmation read fails", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    let views = 0;
    const layer = testLayer(calls, (command, args) => {
      if (command === "code-cli" && args[0] === "auth") {
        return "Logged in to http://git.sankuai.com as liugang59";
      }
      if (command === "code-cli" && args[3] === "view") {
        views += 1;
        if (views === 3) return { stderr: "temporary read failure", code: 1 };
        return JSON.stringify({
          state: "OPEN",
          author: { mis: "author01" },
          fromRef: { commitId: "abc123" },
          reviewers: [],
        });
      }
      return "{}";
    });
    const service = yield* Executor.DaxiangApprovalExecutor.pipe(Effect.provide(layer));
    const result = yield* service.execute(target(prUrl), behavior);
    assert.strictEqual(result.outcome, "deliveryUnknown", result.detail ?? undefined);
    assert.strictEqual(result.key, "pr:group/repo#123@abc123");
    const second = yield* service.execute(target(prUrl), behavior);
    assert.strictEqual(second.outcome, "deliveryUnknown", second.detail ?? undefined);
    assert.strictEqual(
      calls.filter((command) => command.includes("review 123 --approve")).length,
      1,
    );
  }),
);

it.effect("preserves PR comment and approval dedupe across executor restarts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "daxiang-approval-restart-" });
      const calls: string[] = [];
      let viewer = "liugang59";
      let approved = false;
      const reply = (command: string, args: ReadonlyArray<string>): Reply => {
        if (command === "code-cli" && args[0] === "auth") {
          return `Logged in to http://git.sankuai.com as ${viewer}`;
        }
        if (command === "code-cli" && args[3] === "view") {
          return JSON.stringify({
            state: "OPEN",
            author: { mis: "author01" },
            fromRef: { commitId: "abc123" },
            reviewers: approved ? [{ mis: viewer, approved: true }] : [],
          });
        }
        if (command === "code-cli" && args[3] === "review") {
          approved = true;
        }
        return "{}";
      };
      const firstLayer = testLayer(calls, reply, stateDir);
      const first = yield* Executor.DaxiangApprovalExecutor.pipe(
        Effect.flatMap((service) => service.execute(target(prUrl), behavior)),
        Effect.provide(firstLayer),
      );
      assert.strictEqual(first.outcome, "approved", first.detail ?? undefined);
      const secondLayer = testLayer(calls, reply, stateDir);
      const second = yield* Executor.DaxiangApprovalExecutor.pipe(
        Effect.flatMap((service) => service.execute(target(prUrl), behavior)),
        Effect.provide(secondLayer),
      );
      assert.strictEqual(second.outcome, "skipped", second.detail ?? undefined);
      assert.strictEqual(
        calls.filter((command) => command.includes("review 123 --approve")).length,
        1,
      );
      assert.strictEqual(calls.filter((command) => command.includes(" comment 123 ")).length, 1);
      viewer = "otheruser";
      const thirdLayer = testLayer(calls, reply, stateDir);
      const third = yield* Executor.DaxiangApprovalExecutor.pipe(
        Effect.flatMap((service) => service.execute(target(prUrl), behavior)),
        Effect.provide(thirdLayer),
      );
      assert.strictEqual(third.outcome, "approved", third.detail ?? undefined);
      assert.strictEqual(
        calls.filter((command) => command.includes("review 123 --approve")).length,
        2,
      );
      assert.strictEqual(calls.filter((command) => command.includes(" comment 123 ")).length, 2);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect(
  "deduplicates MCM approvals across restarts without blocking the next level or viewer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "daxiang-mcm-approved-" });
        const calls: string[] = [];
        let approveLevel = 2;
        let viewer = "liugang59";
        const reply = (command: string, args: ReadonlyArray<string>): Reply => {
          if (command === "mcm" && args[0] === "user") return JSON.stringify({ mis: viewer });
          if (command === "mcm" && args[0] === "plan" && args[1] === "detail") {
            return JSON.stringify({
              status: 1,
              approveLevel,
              planApproves: [{ level: approveLevel, status: 0, user: { mis: viewer } }],
            });
          }
          if (command === "mcm" && args[0] === "plan" && args[1] === "approve") {
            approveLevel = 3;
          }
          return "{}";
        };
        const service = yield* Executor.DaxiangApprovalExecutor.pipe(
          Effect.provide(testLayer(calls, reply, baseDir)),
        );
        const first = yield* service.execute(target(planUrl), behavior);
        assert.strictEqual(first.outcome, "approved", first.detail ?? undefined);
        assert.strictEqual(first.key, "mcm-plan:mcm.mws.sankuai.com:456@level2");
        approveLevel = 2;
        const restarted = yield* Executor.DaxiangApprovalExecutor.pipe(
          Effect.provide(testLayer(calls, reply, baseDir)),
        );
        assert.strictEqual(
          (yield* restarted.execute(target(planUrl), behavior)).outcome,
          "skipped",
        );
        assert.strictEqual(
          calls.filter((command) => command.includes("plan approve 456")).length,
          1,
        );
        approveLevel = 3;
        const second = yield* restarted.execute(target(planUrl), behavior);
        assert.strictEqual(second.outcome, "approved", second.detail ?? undefined);
        assert.strictEqual(second.key, "mcm-plan:mcm.mws.sankuai.com:456@level3");
        assert.isTrue(
          calls.some((command) => command.includes("plan approve 456 --approve-level 3")),
        );
        viewer = "another-reviewer";
        const otherViewer = yield* restarted.execute(target(planUrl), behavior);
        assert.strictEqual(otherViewer.outcome, "approved", otherViewer.detail ?? undefined);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("revalidates a cached PR approval when the viewer withdraws the review", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    let approvedFlag = true;
    const layer = testLayer(calls, (command, args) => {
      if (command === "code-cli" && args[0] === "auth") {
        return "Logged in to http://git.sankuai.com as liugang59";
      }
      if (command === "code-cli" && args[3] === "view") {
        return JSON.stringify({
          state: "OPEN",
          author: { mis: "author01" },
          fromRef: { commitId: "abc123" },
          reviewers: [{ mis: "liugang59", approved: approvedFlag }],
        });
      }
      if (command === "code-cli" && args[3] === "review") {
        approvedFlag = true;
      }
      return "{}";
    });
    const service = yield* Executor.DaxiangApprovalExecutor.pipe(Effect.provide(layer));
    const first = yield* service.execute(target(prUrl), behavior);
    assert.strictEqual(first.outcome, "approved", first.detail ?? undefined);
    approvedFlag = false;
    const second = yield* service.execute(target(prUrl), behavior);
    assert.strictEqual(second.outcome, "approved", second.detail ?? undefined);
    assert.strictEqual(
      calls.filter((command) => command.includes("review 123 --approve")).length,
      2,
    );
  }),
);

it.effect("preserves unknown MCM outcomes across executor restarts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "daxiang-mcm-unknown-" });
      const calls: string[] = [];
      const reply = (command: string, args: ReadonlyArray<string>): Reply => {
        if (command === "mcm" && args[0] === "user") return JSON.stringify({ mis: "liugang59" });
        if (command === "mcm" && args[0] === "plan" && args[1] === "detail") {
          return JSON.stringify({
            status: 1,
            approveLevel: 2,
            planApproves: [{ level: 2, status: 0, user: { mis: "liugang59" } }],
          });
        }
        if (command === "mcm" && args[0] === "plan" && args[1] === "approve") {
          return { timedOut: true };
        }
        return "{}";
      };
      const first = yield* Executor.DaxiangApprovalExecutor.pipe(
        Effect.flatMap((service) => service.execute(target(planUrl), behavior)),
        Effect.provide(testLayer(calls, reply, stateDir)),
      );
      assert.strictEqual(first.outcome, "deliveryUnknown", first.detail ?? undefined);
      const second = yield* Executor.DaxiangApprovalExecutor.pipe(
        Effect.flatMap((service) => service.execute(target(planUrl), behavior)),
        Effect.provide(testLayer(calls, reply, stateDir)),
      );
      assert.strictEqual(second.outcome, "deliveryUnknown", second.detail ?? undefined);
      assert.strictEqual(calls.filter((command) => command.includes("plan detail 456")).length, 1);
      assert.strictEqual(calls.filter((command) => command.includes("plan approve 456")).length, 1);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("stops automatic approval when saved dedupe state is corrupt or cannot be written", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const calls: string[] = [];
      const reply = (command: string, args: ReadonlyArray<string>): Reply => {
        if (command === "code-cli" && args[0] === "auth") {
          return "Logged in to http://git.sankuai.com as liugang59";
        }
        if (command === "code-cli" && args[3] === "view") {
          return JSON.stringify({
            state: "OPEN",
            author: { mis: "author01" },
            fromRef: { commitId: "abc123" },
            reviewers: [],
          });
        }
        return "{}";
      };
      const corruptBase = yield* fs.makeTempDirectoryScoped({ prefix: "daxiang-corrupt-" });
      yield* fs.makeDirectory(`${corruptBase}/userdata`, { recursive: true });
      yield* fs.writeFileString(`${corruptBase}/userdata/daxiang-approval-pr-commits.json`, "{");
      const corrupt = yield* Executor.DaxiangApprovalExecutor.pipe(
        Effect.flatMap((service) => service.execute(target(prUrl), behavior)),
        Effect.provide(testLayer(calls, reply, corruptBase)),
      );
      assert.strictEqual(corrupt.outcome, "failed", corrupt.detail ?? undefined);
      const unwritableBase = yield* fs.makeTempDirectoryScoped({ prefix: "daxiang-unwritable-" });
      const service = yield* Executor.DaxiangApprovalExecutor.pipe(
        Effect.provide(testLayer(calls, reply, unwritableBase)),
      );
      yield* fs.makeDirectory(`${unwritableBase}/userdata/daxiang-approval-pr-commits.json`);
      const unwritable = yield* service.execute(target(prUrl), behavior);
      assert.strictEqual(unwritable.outcome, "failed", unwritable.detail ?? undefined);
      const attemptedCalls = calls.length;
      yield* fs.remove(`${unwritableBase}/userdata/daxiang-approval-pr-commits.json`, {
        recursive: true,
      });
      assert.strictEqual((yield* service.execute(target(prUrl), behavior)).outcome, "failed");
      assert.strictEqual(calls.length, attemptedCalls);
      assert.isFalse(calls.some((command) => /add-reviewer| comment | review /u.test(command)));
    }),
  ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("does not evict unresolved writes when the safety journal reaches capacity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "daxiang-journal-full-" });
      const statePath = `${baseDir}/userdata/daxiang-approval-pr-commits.json`;
      const contents = JSON.stringify({
        approved: [],
        commented: [],
        unknown: Array.from({ length: 2000 }, (_, index) => `viewer:pr:other/repo#${index}@abc`),
        mcmUnknown: [],
      });
      yield* fs.makeDirectory(`${baseDir}/userdata`);
      yield* fs.writeFileString(statePath, contents);
      const calls: string[] = [];
      const service = yield* Executor.DaxiangApprovalExecutor.pipe(
        Effect.provide(
          testLayer(
            calls,
            (command, args) => {
              if (command === "code-cli" && args[0] === "auth") {
                return "Logged in to http://git.sankuai.com as liugang59";
              }
              return JSON.stringify({
                state: "OPEN",
                author: { mis: "author01" },
                fromRef: { commitId: "abc123" },
                reviewers: [],
              });
            },
            baseDir,
          ),
        ),
      );
      const result = yield* service.execute(target(prUrl), behavior);
      assert.strictEqual(result.outcome, "failed", result.detail ?? undefined);
      assert.strictEqual(yield* fs.readFileString(statePath), contents);
      assert.isFalse(calls.some((command) => /add-reviewer| comment | review /u.test(command)));
    }),
  ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("does not retry a comment after a CLI disconnect reported as a nonzero exit", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const layer = testLayer(calls, (command, args) => {
      if (command === "code-cli" && args[0] === "auth") {
        return "Logged in to http://git.sankuai.com as liugang59";
      }
      if (command === "code-cli" && args[3] === "view") {
        return JSON.stringify({
          state: "OPEN",
          author: { mis: "author01" },
          fromRef: { commitId: "abc123" },
          reviewers: [],
        });
      }
      if (command === "code-cli" && args[3] === "comment") {
        return { code: 1, stderr: "ECONNRESET: connection closed after request" };
      }
      return "{}";
    });
    const service = yield* Executor.DaxiangApprovalExecutor.pipe(Effect.provide(layer));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = yield* service.execute(target(prUrl), behavior);
      assert.strictEqual(result.outcome, "deliveryUnknown", result.detail ?? undefined);
    }
    assert.strictEqual(calls.filter((command) => command.includes(" comment 123 ")).length, 1);
    assert.isFalse(calls.some((command) => command.includes("review 123 --approve")));
  }),
);

it.effect("records an in-flight comment before cancellation so restart cannot post it again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "daxiang-interrupted-" });
      const started = yield* Deferred.make<void>();
      const calls: string[] = [];
      const reply = (
        command: string,
        args: ReadonlyArray<string>,
      ): Reply | Effect.Effect<Reply> => {
        if (command === "code-cli" && args[0] === "auth") {
          return "Logged in to http://git.sankuai.com as liugang59";
        }
        if (command === "code-cli" && args[3] === "view") {
          return JSON.stringify({
            state: "OPEN",
            author: { mis: "author01" },
            fromRef: { commitId: "abc123" },
            reviewers: [],
          });
        }
        if (
          command === "code-cli" &&
          args[3] === "comment" &&
          calls.filter((call) => call.includes(" comment 123 ")).length === 1
        ) {
          return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        }
        return "{}";
      };
      const service = yield* Executor.DaxiangApprovalExecutor.pipe(
        Effect.provide(testLayer(calls, reply, baseDir)),
      );
      const running = yield* Effect.forkChild(service.execute(target(prUrl), behavior));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(running);
      const restarted = yield* Executor.DaxiangApprovalExecutor.pipe(
        Effect.flatMap((executor) => executor.execute(target(prUrl), behavior)),
        Effect.provide(testLayer(calls, reply, baseDir)),
      );
      assert.strictEqual(restarted.outcome, "deliveryUnknown", restarted.detail ?? undefined);
      assert.strictEqual(calls.filter((command) => command.includes(" comment 123 ")).length, 1);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

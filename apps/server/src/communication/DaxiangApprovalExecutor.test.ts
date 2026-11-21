import { assert, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
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
  | { readonly stdout?: string; readonly stderr?: string; readonly code?: number };

function testLayer(
  calls: string[],
  reply: (command: string, args: ReadonlyArray<string>) => Reply,
) {
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
    Effect.sync(() => {
      calls.push([input.command, ...input.args].join(" "));
      const result = reply(input.command, input.args);
      const normalized = typeof result === "string" ? { stdout: result } : result;
      return {
        stdout: normalized.stdout ?? "",
        stderr: normalized.stderr ?? "",
        code: ChildProcessSpawner.ExitCode(normalized.code ?? 0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      };
    });
  return Executor.layer.pipe(
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })),
    Layer.provide(ServerConfig.ServerConfig.layerTest("/tmp", "/tmp")),
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
    const layer = testLayer(calls, (command, args) => {
      if (command === "code-cli" && args[0] === "auth") {
        return "Logged in to http://git.sankuai.com as liugang59 (https://dev.sankuai.com)";
      }
      if (command === "code-cli" && args[0] === "pr" && args[3] === "view") {
        return JSON.stringify({
          state: "OPEN",
          author: { mis: "author01" },
          fromRef: { commitId: "abc123" },
          reviewers: [],
        });
      }
      if (command === "code-cli" && args[3] === "comments") return "[]";
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
  "retries a failed approval without duplicate LGTM, but comments again on a new commit",
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
            reviewers: [],
          });
        }
        if (command === "code-cli" && args[3] === "review") {
          approveAttempts += 1;
          return approveAttempts === 1 ? { stderr: "approval failed", code: 1 } : "{}";
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
    const result = yield* Executor.DaxiangApprovalExecutor.pipe(
      Effect.flatMap((service) => service.execute(target(planUrl), behavior)),
      Effect.provide(layer),
    );
    assert.strictEqual(result.outcome, "approved", result.detail ?? undefined);
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

it.effect("accepts only MCM events that are still AUDITING", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const layer = testLayer(calls, (command, args) => {
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
    assert.isTrue(calls.some((command) => command.includes("event accept 789")));
  }),
);

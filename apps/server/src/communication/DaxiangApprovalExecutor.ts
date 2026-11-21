import { DaxiangApprovalError, type DaxiangApprovalOutcome } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { approvalTargetLabel, type ParsedApprovalTarget } from "./daxiangApprovalLinks.ts";

export interface ApprovalExecutionResult {
  readonly key: string;
  readonly outcome: DaxiangApprovalOutcome;
  readonly detail: string | null;
}

export interface ApprovalMonitorBehavior {
  readonly autoApprovePullRequest: boolean;
  readonly pullRequestComment: string;
  readonly autoApproveMcm: boolean;
  readonly mcmApproveComment: string;
}

export class DaxiangApprovalExecutor extends Context.Service<
  DaxiangApprovalExecutor,
  {
    readonly execute: (
      target: ParsedApprovalTarget,
      behavior: ApprovalMonitorBehavior,
    ) => Effect.Effect<ApprovalExecutionResult>;
  }
>()("t3/communication/DaxiangApprovalExecutor") {}

const PullRequest = Schema.Struct({
  state: Schema.String,
  author: Schema.Struct({ mis: Schema.String }),
  fromRef: Schema.Struct({ commitId: Schema.optional(Schema.String) }),
  reviewers: Schema.Array(
    Schema.Struct({ mis: Schema.String, approved: Schema.optional(Schema.Boolean) }),
  ),
});
const McmUser = Schema.Struct({ mis: Schema.String });
const McmPlan = Schema.Struct({
  status: Schema.Number,
  approveLevel: Schema.Number,
  planApproves: Schema.optional(
    Schema.Array(
      Schema.Struct({
        level: Schema.Number,
        status: Schema.Number,
        user: Schema.Struct({ mis: Schema.String }),
      }),
    ),
  ),
});
const McmEvent = Schema.Struct({
  changeDetail: Schema.Struct({ status: Schema.String }),
});

const decodeJson = <A, I>(schema: Schema.Codec<A, I, never, never>, input: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(input).pipe(
    Effect.mapError(
      () =>
        new DaxiangApprovalError({
          reason: "process_failed",
          detail: "The approval CLI returned an unreadable response.",
        }),
    ),
  );

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message.slice(0, 500)
    : "The approval command failed.";
}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const config = yield* ServerConfig.ServerConfig;
  const commentedPrCommits = new Set<string>();

  const run = Effect.fn("DaxiangApprovalExecutor.run")(function* (
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* runner
      .run({
        command,
        args,
        cwd: config.cwd,
        timeout: "45 seconds",
        maxOutputBytes: 2_000_000,
        outputMode: "truncate",
        env: { MCODE_HOST: "http://git.sankuai.com" },
      })
      .pipe(
        Effect.mapError(
          () =>
            new DaxiangApprovalError({
              reason: "process_failed",
              detail: `Could not run ${command}. Check its installation and authentication.`,
            }),
        ),
      );
    if (result.code !== 0 || result.timedOut) {
      const detail = result.stderr.trim() || result.stdout.trim();
      return yield* new DaxiangApprovalError({
        reason: "process_failed",
        detail: detail.slice(0, 500) || `${command} exited without completing the operation.`,
      });
    }
    return result.stdout;
  });

  const mcmViewer = Effect.fn("DaxiangApprovalExecutor.mcmViewer")(function* () {
    const output = yield* run("mcm", ["user", "my", "-f", "json"]);
    return (yield* decodeJson(McmUser, output)).mis;
  });

  const executePullRequest = Effect.fn("DaxiangApprovalExecutor.executePullRequest")(function* (
    target: Extract<ParsedApprovalTarget, { readonly kind: "pr" }>,
    behavior: ApprovalMonitorBehavior,
  ): Effect.fn.Return<ApprovalExecutionResult, DaxiangApprovalError> {
    const result = yield* Effect.gen(function* () {
      const auth = yield* run("code-cli", ["auth", "status"]);
      const viewer = /Logged in to \S+ as ([^\s(]+)/u.exec(auth)?.[1];
      if (!viewer) {
        return yield* new DaxiangApprovalError({
          reason: "process_failed",
          detail: "Meituan Code is not authenticated. Run code-cli auth login.",
        });
      }
      const prOutput = yield* run("code-cli", [
        "pr",
        "-R",
        target.repository,
        "view",
        String(target.number),
        "--json",
      ]);
      const pr = yield* decodeJson(PullRequest, prOutput);
      const key = `${target.key}@${pr.fromRef.commitId ?? "unknown"}`;
      if (pr.state !== "OPEN" && pr.state !== "DRAFT") {
        return { key, outcome: "skipped" as const, detail: "The pull request is no longer open." };
      }
      if (pr.author.mis.toLowerCase() === viewer.toLowerCase()) {
        return {
          key,
          outcome: "skipped" as const,
          detail: "Meituan Code does not allow authors to approve their own pull requests.",
        };
      }
      if (
        pr.reviewers.some(
          (reviewer) => reviewer.mis.toLowerCase() === viewer.toLowerCase() && reviewer.approved,
        )
      ) {
        return { key, outcome: "skipped" as const, detail: "Already approved at this commit." };
      }
      if (!pr.reviewers.some((reviewer) => reviewer.mis.toLowerCase() === viewer.toLowerCase())) {
        yield* run("code-cli", [
          "pr",
          "-R",
          target.repository,
          "add-reviewer",
          String(target.number),
          "--reviewer",
          viewer,
        ]);
      }
      const alreadyCommented = commentedPrCommits.has(key);
      const comment = behavior.pullRequestComment.trim() || "LGTM";
      if (!alreadyCommented) {
        yield* run("code-cli", [
          "pr",
          "-R",
          target.repository,
          "comment",
          String(target.number),
          "--body",
          comment,
        ]);
        commentedPrCommits.add(key);
      }
      yield* run("code-cli", [
        "pr",
        "-R",
        target.repository,
        "review",
        String(target.number),
        "--approve",
      ]);
      return {
        key,
        outcome: "approved" as const,
        detail: `Approved after ${alreadyCommented ? "reusing" : "posting"} the "${comment}" comment.`,
      };
    });
    return result;
  });

  const executeMcmPlan = Effect.fn("DaxiangApprovalExecutor.executeMcmPlan")(function* (
    target: Extract<ParsedApprovalTarget, { readonly kind: "mcm-plan" }>,
    behavior: ApprovalMonitorBehavior,
  ) {
    const viewer = yield* mcmViewer();
    const detailOutput = yield* run("mcm", ["plan", "detail", target.planId, "-f", "json"]);
    const plan = yield* decodeJson(McmPlan, detailOutput);
    if (plan.status !== 1) {
      return {
        key: target.key,
        outcome: "skipped" as const,
        detail: "The MCM plan is not awaiting approval.",
      };
    }
    const approvals = plan.planApproves ?? [];
    if (
      approvals.length > 0 &&
      !approvals.some(
        (approval) =>
          approval.level === plan.approveLevel &&
          approval.status === 0 &&
          approval.user.mis.toLowerCase() === viewer.toLowerCase(),
      )
    ) {
      return {
        key: target.key,
        outcome: "skipped" as const,
        detail: `The current MCM approval level ${plan.approveLevel} is not assigned to ${viewer}.`,
      };
    }
    yield* run("mcm", [
      "plan",
      "approve",
      target.planId,
      "--approve-level",
      String(plan.approveLevel),
      "--comment",
      behavior.mcmApproveComment.trim() || "自动审批通过",
      "-y",
      "-f",
      "json",
    ]);
    return {
      key: target.key,
      outcome: "approved" as const,
      detail: `MCM plan approved at level ${plan.approveLevel}.`,
    };
  });

  const executeMcmEvent = Effect.fn("DaxiangApprovalExecutor.executeMcmEvent")(function* (
    target: Extract<ParsedApprovalTarget, { readonly kind: "mcm-event" }>,
    behavior: ApprovalMonitorBehavior,
  ) {
    const detailOutput = yield* run("mcm", ["event", "get", target.changeId, "-f", "json"]);
    const event = yield* decodeJson(McmEvent, detailOutput);
    if (event.changeDetail.status !== "AUDITING") {
      return {
        key: target.key,
        outcome: "skipped" as const,
        detail: `The MCM event is ${event.changeDetail.status}, not AUDITING.`,
      };
    }
    yield* run("mcm", [
      "event",
      "accept",
      target.changeId,
      "--comment",
      behavior.mcmApproveComment.trim() || "自动审批通过",
      "-f",
      "json",
    ]);
    return { key: target.key, outcome: "approved" as const, detail: "MCM event accepted." };
  });

  const execute = Effect.fn("DaxiangApprovalExecutor.execute")(function* (
    target: ParsedApprovalTarget,
    behavior: ApprovalMonitorBehavior,
  ) {
    if (target.kind !== "pr" && target.kind !== "mcm-plan" && target.kind !== "mcm-event") {
      return {
        key: target.key,
        outcome: "skipped" as const,
        detail: "This platform requires manual approval.",
      } satisfies ApprovalExecutionResult;
    }
    const enabled =
      target.kind === "pr" ? behavior.autoApprovePullRequest : behavior.autoApproveMcm;
    if (!enabled) {
      return {
        key: target.key,
        outcome: "skipped" as const,
        detail: `Automatic ${target.kind === "pr" ? "pull request" : "MCM"} approval is disabled.`,
      } satisfies ApprovalExecutionResult;
    }
    const operation: Effect.Effect<ApprovalExecutionResult, DaxiangApprovalError> =
      target.kind === "pr"
        ? executePullRequest(target, behavior)
        : target.kind === "mcm-plan"
          ? executeMcmPlan(target, behavior)
          : executeMcmEvent(target, behavior);
    return yield* operation.pipe(
      Effect.catch((error) =>
        Effect.succeed({
          key: target.key,
          outcome: "failed" as const,
          detail: `${approvalTargetLabel(target)}: ${errorMessage(error)}`,
        }),
      ),
    );
  });

  return DaxiangApprovalExecutor.of({ execute });
});

export const layer = Layer.effect(DaxiangApprovalExecutor, make);

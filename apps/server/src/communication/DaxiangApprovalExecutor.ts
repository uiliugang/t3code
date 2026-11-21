import { DaxiangApprovalError, type DaxiangApprovalOutcome } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { resolveMCodeCommand } from "../sourceControl/MCodeRuntime.ts";
import { approvalTargetLabel, type ParsedApprovalTarget } from "./daxiangApprovalLinks.ts";
import { boundedAdd, isProductionMcmTarget } from "./daxiangApprovalState.ts";

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
const McmEventList = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.Number })),
});
const PrCommitState = Schema.Struct({
  approved: Schema.Array(Schema.String),
  commented: Schema.Array(Schema.String),
  unknown: Schema.optional(Schema.Array(Schema.String)),
  mcmUnknown: Schema.optional(Schema.Array(Schema.String)),
});
const encodePrCommitState = Schema.encodeEffect(Schema.fromJsonString(PrCommitState));

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
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commentedPrCommits = new Set<string>();
  const approvedPrCommits = new Set<string>();
  const unknownPrCommits = new Set<string>();
  const unknownMcmTargets = new Set<string>();
  const prResultKeys = new WeakMap<object, string>();
  const prCacheKeys = new WeakMap<object, string>();
  const prWriteAttempted = new WeakMap<object, true>();
  const prCommitStatePath = path.join(config.stateDir, "daxiang-approval-pr-commits.json");
  const persisted = yield* fs.readFileString(prCommitStatePath).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(PrCommitState))),
    Effect.catch(() =>
      Effect.logWarning("Could not read PR approval dedupe state").pipe(
        Effect.as({ approved: [], commented: [], unknown: [], mcmUnknown: [] }),
      ),
    ),
  );
  for (const key of persisted.approved) approvedPrCommits.add(key);
  for (const key of persisted.commented) commentedPrCommits.add(key);
  for (const key of persisted.unknown ?? []) unknownPrCommits.add(key);
  for (const key of persisted.mcmUnknown ?? []) unknownMcmTargets.add(key);
  const persistPrCommits = Effect.fn("DaxiangApprovalExecutor.persistPrCommits")(
    function* () {
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      const contents = yield* encodePrCommitState({
        approved: [...approvedPrCommits],
        commented: [...commentedPrCommits],
        unknown: [...unknownPrCommits],
        mcmUnknown: [...unknownMcmTargets],
      });
      const temporaryPath = `${prCommitStatePath}.${process.pid}.tmp`;
      yield* fs.writeFileString(temporaryPath, contents, { mode: 0o600 });
      yield* fs.rename(temporaryPath, prCommitStatePath);
    },
    (effect) =>
      effect.pipe(
        Effect.catch(() =>
          Effect.logWarning("Failed to persist PR approval dedupe state").pipe(Effect.asVoid),
        ),
      ),
  );

  const run = Effect.fn("DaxiangApprovalExecutor.run")(function* (
    command: string,
    args: ReadonlyArray<string>,
    mutation = false,
  ) {
    const invocation = yield* resolveMCodeCommand({
      operation: "DaxiangApprovalExecutor.run",
      command,
      args,
      cwd: config.cwd,
      env: { MCODE_HOST: "http://git.sankuai.com" },
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        () =>
          new DaxiangApprovalError({
            reason: "process_failed",
            detail: `Could not resolve ${command} on this server.`,
          }),
      ),
    );
    const result = yield* runner
      .run({
        ...invocation,
        timeout: "45 seconds",
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 2_000_000,
        outputMode: "truncate",
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
    if (result.timedOut) {
      return yield* new DaxiangApprovalError({
        reason: mutation ? "unknown" : "process_failed",
        detail: `${command} timed out; the operation outcome is unknown.`,
      });
    }
    if (result.code !== 0) {
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

  const readPullRequest = Effect.fn("DaxiangApprovalExecutor.readPullRequest")(function* (
    target: Extract<ParsedApprovalTarget, { readonly kind: "pr" }>,
  ) {
    const output = yield* run("code-cli", [
      "pr",
      "-R",
      target.repository,
      "view",
      String(target.number),
      "--json",
    ]);
    return yield* decodeJson(PullRequest, output);
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
      const pr = yield* readPullRequest(target);
      const headCommit = pr.fromRef.commitId?.trim();
      const key = `${target.key}@${headCommit || "unknown"}`;
      const cacheKey = `${viewer.toLowerCase()}:${key}`;
      prResultKeys.set(target, key);
      prCacheKeys.set(target, cacheKey);
      if (!headCommit) {
        return {
          key,
          outcome: "skipped" as const,
          detail: "The pull request head commit is missing; approval was not attempted.",
        };
      }
      if (pr.state !== "OPEN") {
        return {
          key,
          outcome: "skipped" as const,
          detail:
            pr.state === "DRAFT"
              ? "Draft pull requests require manual review."
              : "The pull request is no longer open.",
        };
      }
      if (pr.author.mis.toLowerCase() === viewer.toLowerCase()) {
        return {
          key,
          outcome: "skipped" as const,
          detail: "Meituan Code does not allow authors to approve their own pull requests.",
        };
      }
      if (unknownPrCommits.has(cacheKey)) {
        return {
          key,
          outcome: "deliveryUnknown" as const,
          detail:
            "A previous approval attempt has an unknown outcome; it is not retried automatically.",
        };
      }
      const currentReviewer = pr.reviewers.find(
        (reviewer) => reviewer.mis.toLowerCase() === viewer.toLowerCase(),
      );
      if (approvedPrCommits.has(cacheKey) && currentReviewer?.approved === true) {
        return { key, outcome: "skipped" as const, detail: "Already approved at this commit." };
      }
      if (approvedPrCommits.delete(cacheKey)) yield* persistPrCommits();
      if (!pr.reviewers.some((reviewer) => reviewer.mis.toLowerCase() === viewer.toLowerCase())) {
        yield* run(
          "code-cli",
          [
            "pr",
            "-R",
            target.repository,
            "add-reviewer",
            String(target.number),
            "--reviewer",
            viewer,
          ],
          true,
        );
      }
      const alreadyCommented = commentedPrCommits.has(cacheKey);
      const comment = behavior.pullRequestComment.trim() || "LGTM";
      if (!alreadyCommented) {
        prWriteAttempted.set(target, true);
        yield* run(
          "code-cli",
          ["pr", "-R", target.repository, "comment", String(target.number), "--body", comment],
          true,
        );
        prWriteAttempted.delete(target);
        boundedAdd(commentedPrCommits, cacheKey, 2000);
        yield* persistPrCommits();
      }
      const latest = yield* readPullRequest(target);
      if (latest.fromRef.commitId?.trim() !== headCommit || latest.state !== "OPEN") {
        return {
          key,
          outcome: "skipped" as const,
          detail: "The pull request head changed during approval; the new commit was not approved.",
        };
      }
      prWriteAttempted.set(target, true);
      yield* run(
        "code-cli",
        ["pr", "-R", target.repository, "review", String(target.number), "--approve"],
        true,
      );
      const approved = yield* readPullRequest(target).pipe(
        Effect.mapError(
          () =>
            new DaxiangApprovalError({
              reason: "unknown",
              detail: `Approval was attempted at ${headCommit}, but the confirmation read failed.`,
            }),
        ),
      );
      if (approved.fromRef.commitId?.trim() !== headCommit) {
        return yield* new DaxiangApprovalError({
          reason: "unknown",
          detail:
            "Approval was attempted at the previous head, but the current head changed. Review it manually; no withdrawal was attempted.",
        });
      }
      const confirmedReviewer = approved.reviewers.find(
        (reviewer) => reviewer.mis.toLowerCase() === viewer.toLowerCase(),
      );
      if (confirmedReviewer?.approved !== true) {
        return yield* new DaxiangApprovalError({
          reason: "unknown",
          detail: "The approval was not confirmed for the current viewer at the expected head.",
        });
      }
      boundedAdd(approvedPrCommits, cacheKey, 2000);
      yield* persistPrCommits();
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
    if (unknownMcmTargets.has(target.key)) {
      return {
        key: target.key,
        outcome: "deliveryUnknown" as const,
        detail:
          "A previous MCM approval attempt has an unknown outcome; it is not retried automatically.",
      };
    }
    const detailOutput = yield* run("mcm", ["plan", "detail", target.planId, "-f", "json"]);
    const plan = yield* decodeJson(McmPlan, detailOutput);
    const key = `${target.key}@level${plan.approveLevel}`;
    prResultKeys.set(target, key);
    if (plan.status !== 1) {
      return {
        key,
        outcome: "skipped" as const,
        detail: "The MCM plan is not awaiting approval.",
      };
    }
    const approvals = plan.planApproves ?? [];
    if (
      !approvals.some(
        (approval) =>
          approval.level === plan.approveLevel &&
          approval.status === 0 &&
          approval.user.mis.toLowerCase() === viewer.toLowerCase(),
      )
    ) {
      return {
        key,
        outcome: "skipped" as const,
        detail: `The current MCM approval level ${plan.approveLevel} is not assigned to ${viewer}.`,
      };
    }
    yield* run(
      "mcm",
      [
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
      ],
      true,
    );
    return {
      key,
      outcome: "approved" as const,
      detail: `MCM plan approved at level ${plan.approveLevel}.`,
    };
  });

  const mcmEventPending = Effect.fn("DaxiangApprovalExecutor.mcmEventPending")(function* (
    target: Extract<ParsedApprovalTarget, { readonly kind: "mcm-event" }>,
  ) {
    for (let page = 1; page <= 100; page += 1) {
      const output = yield* run("mcm", [
        "event",
        "list",
        "-t",
        "TODO",
        "-p",
        String(page),
        "-s",
        "100",
        "-f",
        "json",
      ]);
      const pending = yield* decodeJson(McmEventList, output);
      if (pending.items.some((item) => String(item.id) === target.changeId)) return true;
      if (pending.items.length < 100) return false;
    }
    return false;
  });

  const executeMcmEvent = Effect.fn("DaxiangApprovalExecutor.executeMcmEvent")(function* (
    target: Extract<ParsedApprovalTarget, { readonly kind: "mcm-event" }>,
    behavior: ApprovalMonitorBehavior,
  ) {
    if (unknownMcmTargets.has(target.key)) {
      return {
        key: target.key,
        outcome: "deliveryUnknown" as const,
        detail:
          "A previous MCM approval attempt has an unknown outcome; it is not retried automatically.",
      };
    }
    if (!(yield* mcmEventPending(target))) {
      return {
        key: target.key,
        outcome: "skipped" as const,
        detail: "The MCM event is not in the current user's pending approval list.",
      };
    }
    const detailOutput = yield* run("mcm", ["event", "get", target.changeId, "-f", "json"]);
    const event = yield* decodeJson(McmEvent, detailOutput);
    if (event.changeDetail.status !== "AUDITING") {
      return {
        key: target.key,
        outcome: "skipped" as const,
        detail: `The MCM event is ${event.changeDetail.status}, not AUDITING.`,
      };
    }
    yield* run(
      "mcm",
      [
        "event",
        "accept",
        target.changeId,
        "--comment",
        behavior.mcmApproveComment.trim() || "自动审批通过",
        "-f",
        "json",
      ],
      true,
    );
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
    if (
      (target.kind === "mcm-plan" || target.kind === "mcm-event") &&
      !isProductionMcmTarget(target)
    ) {
      return {
        key: target.key,
        outcome: "skipped" as const,
        detail:
          "Automatic MCM approval is limited to production links; review this test link manually.",
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
        Effect.gen(function* () {
          const cacheKey = prCacheKeys.get(target);
          if (error.reason === "unknown" && cacheKey && prWriteAttempted.get(target)) {
            boundedAdd(unknownPrCommits, cacheKey, 2000);
          }
          if (error.reason === "unknown" && target.kind !== "pr") {
            boundedAdd(unknownMcmTargets, target.key, 2000);
          }
          if (error.reason === "unknown") yield* persistPrCommits();
          const nonRetryable =
            error.reason === "unknown" &&
            (target.kind !== "pr" || prWriteAttempted.get(target) === true);
          return nonRetryable
            ? {
                key: prResultKeys.get(target) ?? target.key,
                outcome: "deliveryUnknown" as const,
                detail: `${approvalTargetLabel(target)}: ${errorMessage(error)} Do not retry automatically.`,
              }
            : {
                key: prResultKeys.get(target) ?? target.key,
                outcome: "failed" as const,
                detail: `${approvalTargetLabel(target)}: ${errorMessage(error)}`,
              };
        }),
      ),
    );
  });

  return DaxiangApprovalExecutor.of({ execute });
});

export const layer = Layer.effect(DaxiangApprovalExecutor, make);

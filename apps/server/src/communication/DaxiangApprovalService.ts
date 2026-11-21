import {
  DaxiangApprovalError,
  type DaxiangApprovalMutation,
  type DaxiangApprovalRecord,
  type DaxiangApprovalState,
  type DaxiangApprovalStatus,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveCommandPath } from "@t3tools/shared/shell";
import { readMis } from "@t3tools/source-control-meituan/shared/definition";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import { makeSkillInstallerNode } from "../skills/skillInstallerNode.ts";
import * as DaxiangMessages from "./DaxiangMessageService.ts";
import * as Executor from "./DaxiangApprovalExecutor.ts";
import {
  approvalMessageKey,
  approvalWatchSettingsKey,
  autoApprovalDedupeKey,
  boundedAdd,
  isProductionMcmTarget,
  isSelfAuthoredApprovalEvent,
  manualApprovalOutcome,
  shouldHandleMessageOutcome,
  shouldRememberApprovalOutcome,
  shouldReplyToSender,
} from "./daxiangApprovalState.ts";
import {
  approvalTargetLabel,
  extractApprovalTargets,
  isDirectAutoApproveKind,
  type ParsedApprovalTarget,
} from "./daxiangApprovalLinks.ts";

const EMPTY_STATE: DaxiangApprovalState = {
  status: "disabled",
  loggedIn: false,
  uid: null,
  expiresAt: null,
  error: null,
  records: [],
};
const DumboStatus = Schema.Struct({
  loggedIn: Schema.Boolean,
  uid: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.NullOr(Schema.String)),
});
const DumboWatchMessage = Schema.Struct({
  event: Schema.String,
  msgId: Schema.optional(Schema.String),
  msgUuid: Schema.optional(Schema.String),
  cts: Schema.optional(Schema.Number),
  sessionType: Schema.String,
  sessionId: Schema.String,
  fromName: Schema.optional(Schema.String),
  fromUid: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  body: Schema.optional(Schema.Unknown),
  extension: Schema.optional(Schema.Unknown),
});
type DumboWatchMessage = typeof DumboWatchMessage.Type;

const decodeStatus = Schema.decodeEffect(Schema.fromJsonString(DumboStatus));
const decodeWatchMessage = Schema.decodeEffect(Schema.fromJsonString(DumboWatchMessage));
const isDaxiangApprovalError = Schema.is(DaxiangApprovalError);

export class DaxiangApprovalService extends Context.Service<
  DaxiangApprovalService,
  {
    readonly subscribe: Stream.Stream<DaxiangApprovalState, DaxiangApprovalError>;
    readonly mutate: (input: DaxiangApprovalMutation) => Effect.Effect<void, DaxiangApprovalError>;
    readonly start: Effect.Effect<void, DaxiangApprovalError>;
  }
>()("t3/communication/DaxiangApprovalService") {}

interface CliInvocation {
  readonly command: string;
  readonly prefix: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
}

function cliError(reason: DaxiangApprovalError["reason"], detail: string) {
  return new DaxiangApprovalError({ reason, detail: detail.slice(0, 500) });
}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const executor = yield* Executor.DaxiangApprovalExecutor;
  const runner = yield* ProcessRunner.ProcessRunner;
  const launcher = yield* ExternalLauncher.ExternalLauncher;
  const messages = yield* DaxiangMessages.DaxiangMessageService;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Scope.Scope;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostEnv = yield* HostProcess.Environment;
  const skillInstallerNode = yield* makeSkillInstallerNode;
  const state = yield* SubscriptionRef.make<DaxiangApprovalState>(EMPTY_STATE);
  const reconcileLock = yield* Semaphore.make(1);
  const handledTargets = new Set<string>();
  const handledMessages = new Set<string>();
  let anonymousMessageSequence = 0;
  let watchFiber: Fiber.Fiber<void, never> | undefined;

  const publishStatus = (status: DaxiangApprovalStatus, error: string | null = null) =>
    SubscriptionRef.update(state, (current) => ({ ...current, status, error }));
  const publishCredentials = (input: {
    readonly loggedIn: boolean;
    readonly uid?: string | undefined;
    readonly expiresAt?: string | null | undefined;
  }) =>
    SubscriptionRef.update(state, (current) => ({
      ...current,
      loggedIn: input.loggedIn,
      uid: input.uid === undefined ? current.uid : input.uid,
      expiresAt: input.expiresAt === undefined ? current.expiresAt : input.expiresAt,
    }));

  const resolveInvocation = Effect.fn("DaxiangApprovalService.resolveInvocation")(
    function* () {
      const executable = yield* resolveCommandPath("dumbo-web", { env: hostEnv }).pipe(
        Effect.mapError(() =>
          cliError("missing_cli", "dumbo-web is not installed on this server."),
        ),
      );
      if (!executable) {
        return yield* cliError("missing_cli", "dumbo-web is not installed on this server.");
      }
      const invocation = yield* skillInstallerNode(executable, [], hostEnv).pipe(
        Effect.mapError(() =>
          cliError("missing_cli", "dumbo-web requires Node.js 20 or newer on this server."),
        ),
      );
      return {
        command: invocation?.command ?? executable,
        prefix: invocation?.args ?? [],
        ...(invocation?.env ? { env: invocation.env } : {}),
      } satisfies CliInvocation;
    },
    (effect) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
  );

  const runDumbo = Effect.fn("DaxiangApprovalService.runDumbo")(function* (
    args: ReadonlyArray<string>,
    timeout: "20 seconds" | "45 seconds" = "20 seconds",
  ) {
    const invocation = yield* resolveInvocation();
    const result = yield* runner
      .run({
        command: invocation.command,
        args: [...invocation.prefix, ...args],
        cwd: config.cwd,
        timeout,
        maxOutputBytes: 1_000_000,
        outputMode: "truncate",
        ...(invocation.env ? { env: invocation.env } : {}),
      })
      .pipe(
        Effect.mapError(() =>
          cliError("process_failed", "Could not run dumbo-web on this server."),
        ),
      );
    if (result.code !== 0 || result.timedOut) {
      const detail = result.stderr.trim() || result.stdout.trim();
      return yield* cliError(
        /not logged in|run `dumbo-web login`|missing cookies/iu.test(detail)
          ? "login_failed"
          : "process_failed",
        detail || "dumbo-web did not complete the operation.",
      );
    }
    return result.stdout;
  });

  const appendRecord = Effect.fn("DaxiangApprovalService.appendRecord")(function* (
    record: DaxiangApprovalRecord,
  ) {
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      records: [record, ...current.records.filter((entry) => entry.id !== record.id)].slice(0, 50),
    }));
  });

  const notifyOwner = Effect.fn("DaxiangApprovalService.notifyOwner")(function* (
    saved: ServerSettings,
    target: ParsedApprovalTarget,
    detail: string,
  ) {
    const mis = readMis(saved.sourceControlHosts.meituan);
    if (!saved.daxiang.clientId.trim() || !saved.daxiang.clientSecret || !mis) {
      return "not_configured" as const;
    }
    return yield* messages
      .sendLink({
        recipients: [mis],
        title: `审批提醒：${approvalTargetLabel(target)}`,
        description: detail,
        url: target.url,
      })
      .pipe(
        Effect.map((result): "sent" | "failed" | "unknown" => {
          if (result.recipients.some((recipient) => recipient.status === "sent")) return "sent";
          if (result.recipients.some((recipient) => recipient.status === "unknown")) {
            return "unknown";
          }
          return "failed";
        }),
        Effect.orElseSucceed(() => "failed" as const),
      );
  });

  const replyToSender = Effect.fn("DaxiangApprovalService.replyToSender")(function* (
    event: DumboWatchMessage,
    text: string,
  ) {
    if (
      (event.sessionType !== "chat" && event.sessionType !== "groupchat") ||
      !event.msgId ||
      !event.sessionId
    )
      return;
    yield* runDumbo(
      [
        "reply",
        "--session-id",
        event.sessionId,
        "--type",
        event.sessionType,
        "--message-id",
        event.msgId,
        "--text",
        text.slice(0, 1000),
        "--confirm-send",
      ],
      "45 seconds",
    ).pipe(Effect.ignoreCause({ log: true }));
  });

  const handleManualTarget = Effect.fn("DaxiangApprovalService.handleManualTarget")(function* (
    saved: ServerSettings,
    target: ParsedApprovalTarget,
    event: DumboWatchMessage,
    messageKey: string,
  ) {
    const monitor = saved.daxiang.approvalMonitor;
    let browserOpened = false;
    let openError: string | null = null;
    if (monitor.autoOpenUnsupportedInBrowser) {
      browserOpened = yield* launcher.launchBrowser(target.url).pipe(
        Effect.as(true),
        Effect.catch((error) => Effect.succeed(((openError = error.message.slice(0, 300)), false))),
      );
    }
    const autoKind = isDirectAutoApproveKind(target.kind);
    const autoDisabled = autoKind
      ? target.kind === "pr"
        ? !monitor.autoApprovePullRequest
        : !monitor.autoApproveMcm
      : true;
    const shouldNotify = monitor.notifyUnsupportedLinks;
    const detail =
      autoKind && autoDisabled
        ? "Automatic approval is disabled; review this link manually."
        : "This platform has no supported automatic approval CLI; review this link manually.";
    const daXiangDelivery = shouldNotify
      ? yield* notifyOwner(saved, target, detail)
      : ("not_configured" as const);
    const outcome = manualApprovalOutcome({
      browserOpened,
      openError,
      shouldNotify,
      daXiangDelivery,
    });
    const record: DaxiangApprovalRecord = {
      id: `${messageKey}:${target.key}`,
      kind: target.kind,
      title: approvalTargetLabel(target),
      url: target.url,
      senderName: event.fromName ?? null,
      outcome,
      detail:
        outcome === "deliveryUnknown"
          ? `${detail} DaXiang delivery is unknown; not retrying automatically.`
          : openError
            ? `${detail} Browser: ${openError}`
            : detail,
      browserOpened,
      createdAt: yield* Clock.currentTimeMillis,
    };
    yield* Effect.uninterruptible(appendRecord(record));
    if (monitor.replyOnHandled && shouldReplyToSender(outcome)) {
      yield* replyToSender(event, `${detail}\n${target.url}`);
    }
    return outcome;
  });

  const handleTarget = Effect.fn("DaxiangApprovalService.handleTarget")(function* (
    saved: ServerSettings,
    target: ParsedApprovalTarget,
    event: DumboWatchMessage,
    messageKey: string,
  ) {
    const monitor = saved.daxiang.approvalMonitor;
    const shouldExecute =
      isDirectAutoApproveKind(target.kind) &&
      isProductionMcmTarget(target) &&
      (target.kind === "pr" ? monitor.autoApprovePullRequest : monitor.autoApproveMcm);
    if (!shouldExecute) {
      return yield* handleManualTarget(saved, target, event, messageKey);
    }
    if (handledTargets.has(autoApprovalDedupeKey(target.key))) return "skipped" as const;
    const result = yield* executor.execute(target, monitor);
    if (handledTargets.has(autoApprovalDedupeKey(result.key))) return "skipped" as const;
    if (result.outcome === "skipped" && result.detail?.includes("disabled")) {
      return yield* handleManualTarget(saved, target, event, messageKey);
    }
    const record: DaxiangApprovalRecord = {
      id: `${messageKey}:${result.key}`,
      kind: target.kind,
      title: approvalTargetLabel(target),
      url: target.url,
      senderName: event.fromName ?? null,
      outcome: result.outcome,
      detail: result.detail,
      browserOpened: false,
      createdAt: yield* Clock.currentTimeMillis,
    };
    yield* Effect.uninterruptible(appendRecord(record));
    if (shouldRememberApprovalOutcome(result.outcome, result.detail)) {
      boundedAdd(handledTargets, autoApprovalDedupeKey(result.key), 2000);
      if (result.outcome === "deliveryUnknown" && target.kind !== "pr") {
        boundedAdd(handledTargets, autoApprovalDedupeKey(target.key), 2000);
      }
    }
    if (monitor.replyOnHandled && shouldReplyToSender(result.outcome)) {
      const summary = result.detail ?? `Approval ${result.outcome}`;
      yield* replyToSender(event, `${approvalTargetLabel(target)}: ${summary}`);
    }
    return result.outcome;
  });

  const handleEvent = Effect.fn("DaxiangApprovalService.handleEvent")(function* (
    event: DumboWatchMessage,
    ownUid?: string,
  ) {
    if (event.event !== "message" || isSelfAuthoredApprovalEvent(event, ownUid)) return;
    const saved = yield* settings.getSettings.pipe(
      Effect.mapError(() => cliError("storage", "Could not read the Meituan settings.")),
    );
    if (!saved.meituanIntegrationEnabled || !saved.daxiang.approvalMonitor.enabled) return;
    if (event.sessionType === "groupchat" && !saved.daxiang.approvalMonitor.includeGroupChats) {
      return;
    }
    const targets = extractApprovalTargets(event);
    if (targets.length === 0) return;
    const messageKey = approvalMessageKey(event, targets, ++anonymousMessageSequence);
    for (const target of targets) {
      const targetMessageKey = `${messageKey}:${target.key}`;
      if (handledMessages.has(targetMessageKey)) continue;
      const outcome = yield* handleTarget(saved, target, event, messageKey);
      if (shouldHandleMessageOutcome(outcome)) {
        boundedAdd(handledMessages, targetMessageKey, 5000);
      }
    }
  });

  const watchOnce = Effect.fn("DaxiangApprovalService.watchOnce")(function* (
    invocation: CliInvocation,
    ownUid?: string,
  ) {
    const lastError = yield* Ref.make("");
    yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner
          .spawn(
            ChildProcess.make(invocation.command, [...invocation.prefix, "watch"], {
              cwd: config.cwd,
              forceKillAfter: "1 second",
              ...(invocation.env ? { env: invocation.env, extendEnv: true } : {}),
            }),
          )
          .pipe(
            Effect.mapError(() => cliError("process_failed", "Could not start dumbo-web watch.")),
          );
        yield* publishCredentials({ loggedIn: true });
        yield* publishStatus("listening");
        const stdout = child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) =>
            line.trim()
              ? decodeWatchMessage(line).pipe(
                  Effect.flatMap((event) => handleEvent(event, ownUid)),
                  Effect.ignoreCause({ log: true }),
                )
              : Effect.void,
          ),
        );
        const stderr = child.stderr.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => Ref.set(lastError, line.slice(0, 500))),
        );
        yield* Effect.all([stdout, stderr, child.exitCode], { concurrency: "unbounded" });
      }),
    ).pipe(
      Effect.mapError((error) =>
        isDaxiangApprovalError(error)
          ? error
          : cliError("process_failed", "The DaXiang listener stopped unexpectedly."),
      ),
    );
    const detail = yield* Ref.get(lastError);
    return yield* cliError(
      /not logged in|login failed|missing cookies/iu.test(detail)
        ? "login_failed"
        : "process_failed",
      detail || "The DaXiang listener disconnected.",
    );
  });

  const startWatch = (invocation: CliInvocation, ownUid?: string) => {
    const loop: Effect.Effect<void, never> = Effect.gen(function* () {
      yield* publishStatus("connecting");
      const outcome = yield* watchOnce(invocation, ownUid).pipe(Effect.result);
      if (outcome._tag === "Failure") {
        const error = outcome.failure;
        yield* publishCredentials({ loggedIn: error.reason !== "login_failed" });
        yield* publishStatus(
          error.reason === "login_failed" ? "unauthenticated" : "error",
          error.message,
        );
      }
      yield* Effect.sleep("15 seconds");
    }).pipe(Effect.forever, Effect.asVoid);
    return Effect.forkScoped(loop);
  };

  const reconcile = Effect.fn("DaxiangApprovalService.reconcile")(
    function* () {
      if (watchFiber) {
        yield* Fiber.interrupt(watchFiber);
        watchFiber = undefined;
      }
      const saved = yield* settings.getSettings.pipe(
        Effect.mapError(() => cliError("storage", "Could not read the Meituan settings.")),
      );
      if (!saved.meituanIntegrationEnabled || !saved.daxiang.approvalMonitor.enabled) {
        yield* publishCredentials({ loggedIn: false });
        return yield* publishStatus("disabled");
      }
      const invocation = yield* resolveInvocation();
      const statusOutput = yield* runDumbo(["status"]);
      const status = yield* decodeStatus(statusOutput).pipe(
        Effect.mapError(() => cliError("process_failed", "Could not read dumbo-web login status.")),
      );
      yield* publishCredentials(status);
      if (!status.loggedIn) {
        return yield* publishStatus(
          "unauthenticated",
          "Import DaXiang web credentials from your logged-in Chrome session.",
        );
      }
      watchFiber = yield* startWatch(invocation, status.uid);
    },
    reconcileLock.withPermits(1),
    (effect) =>
      effect.pipe(
        Effect.catch((error: DaxiangApprovalError) =>
          publishCredentials({ loggedIn: false }).pipe(
            Effect.andThen(
              publishStatus(
                error.reason === "missing_cli"
                  ? "missing_cli"
                  : error.reason === "login_failed"
                    ? "unauthenticated"
                    : "error",
                error.message,
              ),
            ),
          ),
        ),
      ),
  );

  const mutate = Effect.fn("DaxiangApprovalService.mutate")(
    function* (input: DaxiangApprovalMutation) {
      if (input.type === "clear_records") {
        return yield* SubscriptionRef.update(state, (current) => ({ ...current, records: [] }));
      }
      if (input.type === "login") {
        const saved = yield* settings.getSettings.pipe(
          Effect.mapError(() => cliError("storage", "Could not read the Meituan settings.")),
        );
        const port = input.port ?? saved.daxiang.approvalMonitor.chromeCdpPort;
        yield* runDumbo(["login", "--port", String(port)], "45 seconds").pipe(
          Effect.mapError((error) =>
            error.reason === "missing_cli" ? error : cliError("login_failed", error.message),
          ),
        );
      }
      yield* reconcile();
    },
    (effect) => effect.pipe(Effect.provideService(Scope.Scope, scope)),
  );

  const start = Effect.fn("DaxiangApprovalService.start")(
    function* () {
      const changes = settings.subscribeChanges.pipe(
        Effect.map((updates) =>
          Stream.fromEffect(
            settings.getSettings.pipe(
              Effect.map(approvalWatchSettingsKey),
              Effect.orElseSucceed(() => null),
            ),
          ).pipe(
            Stream.map((key) => key ?? "initial-reconcile"),
            Stream.concat(updates.pipe(Stream.map(approvalWatchSettingsKey))),
          ),
        ),
      );
      yield* Stream.unwrap(changes).pipe(
        Stream.changes,
        Stream.runForEach(() => reconcile().pipe(Effect.ignoreCause({ log: true }))),
        Effect.forkScoped,
      );
    },
    (effect) => effect.pipe(Effect.provideService(Scope.Scope, scope)),
  );

  return DaxiangApprovalService.of({
    subscribe: SubscriptionRef.changes(state),
    mutate,
    start: start(),
  });
});

export const layer = Layer.effect(DaxiangApprovalService, make);

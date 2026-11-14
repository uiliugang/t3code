import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  CommandId,
  MessageId,
  WechatError,
  type WechatMutation,
  WechatState,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import * as Client from "./WechatClient.ts";
import * as Store from "./WechatStore.ts";

const EMPTY: WechatState = {
  status: "unpaired",
  enabled: false,
  activated: false,
  botId: null,
  userId: null,
  threadId: null,
  projectId: null,
  pushEnabled: true,
  pushAllThreads: false,
  qrCode: null,
  bindingCode: null,
  expiresAt: null,
  error: null,
  deliveries: [],
  targets: [],
};
const secretName = (generation: string) => `wechat-${generation}`;
const Credential = Schema.Struct({
  token: Schema.String,
  contextToken: Schema.optional(Schema.String),
  bindingCode: Schema.optional(Schema.String),
});
const decodeCredential = Schema.decodeEffect(Schema.fromJsonString(Credential));
const encodeCredential = Schema.encodeEffect(Schema.fromJsonString(Credential));
const decodeIncoming = Schema.decodeEffect(Schema.fromJsonString(Store.Incoming));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(WechatState));
const isMissingThread = Schema.is(ProjectionStore.ProjectionStoreThreadNotFoundError);
const fail = (reason: WechatError["reason"]) => new WechatError({ reason });

export class WechatBridge extends Context.Service<
  WechatBridge,
  {
    readonly subscribe: Stream.Stream<WechatState, WechatError>;
    readonly mutate: (input: WechatMutation) => Effect.Effect<void, WechatError>;
    readonly send: (text: string) => Effect.Effect<void, WechatError>;
    readonly start: Effect.Effect<void, WechatError>;
  }
>()("t3/communication/WechatBridge") {}

const make = Effect.gen(function* () {
  const client = yield* Client.WechatClient;
  const store = yield* Store.WechatStore;
  const secrets = yield* Secrets.ServerSecretStore;
  const threads = yield* Threads.ThreadManagementService;
  const events = yield* Events.EventSinkV2;
  const latestSequence = events.latestSequence().pipe(Effect.mapError(() => fail("storage")));
  const random = yield* SecureRandom.SecureRandom;
  const owner = yield* random.uuidV4().pipe(Effect.mapError(() => fail("storage")));
  const scope = yield* Scope.Scope;
  const mutex = yield* Semaphore.make(1);
  const state = yield* SubscriptionRef.make<WechatState>(EMPTY);
  let qr:
    | { value: string; baseUrl: string; generation: string; code?: string | undefined }
    | undefined;
  let started = false;
  let polling: Fiber.Fiber<void, WechatError> | undefined;
  let runtimeStatus: WechatState["status"] | undefined;
  let error: WechatState["error"] = null;

  const credential = Effect.fn("WechatBridge.credential")(function* (connection: Store.Connection) {
    const bytes = yield* secrets
      .get(secretName(connection.generation))
      .pipe(Effect.mapError(() => fail("storage")));
    if (Option.isNone(bytes)) return yield* fail("credentials");
    return yield* decodeCredential(new TextDecoder().decode(bytes.value)).pipe(
      Effect.mapError(() => fail("credentials")),
    );
  });
  const saveCredential = Effect.fn("WechatBridge.saveCredential")(
    function* (generation: string, value: typeof Credential.Type) {
      const text = yield* encodeCredential(value);
      yield* secrets.set(secretName(generation), new TextEncoder().encode(text));
    },
    Effect.mapError(() => fail("storage")),
  );
  let lastPublished = "";
  const publish = Effect.fn("WechatBridge.publish")(function* () {
    const connection = yield* store.connection;
    const previous = yield* SubscriptionRef.get(state);
    const deliveries = connection ? yield* store.deliveries(connection.generation) : [];
    const next: WechatState = {
      ...previous,
      enabled: connection?.enabled ?? false,
      activated: connection?.activated ?? false,
      botId: connection?.botId ?? null,
      userId: connection?.userId ?? null,
      threadId: connection?.threadId ?? null,
      projectId: connection?.projectId ?? null,
      pushEnabled: connection?.pushEnabled ?? true,
      pushAllThreads: connection?.pushAllThreads ?? false,
      status:
        runtimeStatus ?? (connection ? (connection.enabled ? "connected" : "offline") : "unpaired"),
      qrCode: qr ? previous.qrCode : null,
      bindingCode:
        connection && !connection.userId && runtimeStatus !== "reconnect_required"
          ? ((yield* credential(connection)).bindingCode ?? null)
          : null,
      expiresAt: qr ? previous.expiresAt : null,
      error,
      deliveries: deliveries.slice(0, 20).map((row) => ({
        id: row.id,
        status: row.status,
        preview: row.text.slice(0, 100),
        createdAt: row.created_at,
        attempts: row.attempts,
      })),
      targets: previous.targets,
    };
    const encoded = yield* encodeState(next).pipe(Effect.mapError(() => fail("storage")));
    if (encoded !== lastPublished) {
      lastPublished = encoded;
      yield* SubscriptionRef.set(state, next);
    }
  });
  let recovered = false;
  const claim = Effect.fn("WechatBridge.claim")(function* () {
    if (!(yield* store.lease(owner, yield* Clock.currentTimeMillis))) return yield* fail("busy");
    if (!recovered) {
      yield* store.recover;
      recovered = true;
    }
    if (error === "busy") {
      error = null;
      runtimeStatus = undefined;
    }
  });
  const enqueue = Effect.fn("WechatBridge.enqueue")(function* (
    connection: Store.Connection,
    id: string,
    text: string,
    request?: Parameters<Store.WechatStore["Service"]["enqueue"]>[4],
  ) {
    yield* store.enqueue(
      connection.generation,
      id,
      text.slice(0, 32000),
      yield* Clock.currentTimeMillis,
      request,
    );
  });
  const target = Effect.fn("WechatBridge.target")(function* (connection: Store.Connection) {
    if (!connection.threadId || !connection.projectId) return yield* fail("target");
    const records = yield* threads
      .getProjectThreadRecords({ projectId: connection.projectId, threadId: connection.threadId }, [
        "runs",
      ])
      .pipe(Effect.mapError(() => fail("target")));
    if (
      records.thread.archivedAt !== null ||
      records.thread.deletedAt !== null ||
      records.thread.lineage.relationshipToParent === "subagent"
    )
      return yield* fail("target");
    return { ...records, threadId: connection.threadId, projectId: connection.projectId };
  });
  const processInbox = Effect.fn("WechatBridge.processInbox")(function* (
    connection: Store.Connection,
  ) {
    for (const row of yield* store.inbox(connection.generation)) {
      const message = yield* decodeIncoming(row.payload).pipe(
        Effect.mapError(() => fail("storage")),
      );
      const replyId = `inbound:${message.id}`;
      if (!connection.activated || connection.activationMessageId === row.id) {
        connection = { ...connection, activated: true, activationMessageId: row.id };
        yield* store.save(connection);
        yield* enqueue(
          connection,
          replyId,
          "微信已连接。请在 T3 的通讯设置中选择会话，然后发送任务。/status 查看状态，/stop 停止任务，/help 查看帮助。",
        );
      } else if (message.text === "/help") {
        yield* enqueue(
          connection,
          replyId,
          "发送文字继续当前 T3 会话；任务忙碌时会排队。/status 查看状态，/stop 停止当前任务。审批和问答请回到 T3 处理。",
        );
      } else {
        const selected = yield* target(connection).pipe(Effect.option);
        if (Option.isNone(selected)) {
          yield* enqueue(
            connection,
            replyId,
            "目标会话不可用。请在 T3 → 设置 → 通讯中重新选择会话。",
          );
        } else if (message.text === "/status") {
          const active = Threads.latestActiveRun(selected.value);
          yield* enqueue(
            connection,
            replyId,
            `${selected.value.thread.title}\n${active ? "任务运行中" : "等待任务"}`,
          );
        } else if (message.text === "/stop") {
          const stopId = CommandId.make(`wechat:${row.id}:stop`);
          const accepted = yield* threads
            .hasReceipt(stopId)
            .pipe(Effect.mapError(() => fail("storage")));
          const active = Threads.latestActiveRun(selected.value);
          if (active && !accepted)
            yield* threads
              .dispatch({
                type: "run.interrupt",
                commandId: stopId,
                threadId: selected.value.threadId,
                runId: active.id,
                holdQueue: true,
              })
              .pipe(Effect.mapError(() => fail("target")));
          yield* enqueue(
            connection,
            replyId,
            active ? "已请求停止当前任务，并暂停队列。" : "当前没有运行中的任务。",
          );
        } else if (message.text.startsWith("/")) {
          yield* enqueue(connection, replyId, "未知微信命令。发送 /help 查看帮助。");
        } else {
          yield* threads
            .sendToThread({
              projectId: selected.value.projectId,
              threadId: selected.value.threadId,
              commandId: CommandId.make(`wechat:${row.id}`),
              messageId: MessageId.make(`wechat:${row.id}`),
              text: message.text,
              attachments: [],
              mode: "queue",
              createdBy: "user",
              creationSource: "server",
            })
            .pipe(Effect.mapError(() => fail("target")));
          yield* enqueue(connection, replyId, "已接收，任务已加入当前会话。");
        }
      }
      yield* store.complete(row.id);
    }
  });
  const sendPending = Effect.fn("WechatBridge.sendPending")(function* (
    connection: Store.Connection,
  ) {
    if (!connection.activated) return;
    const auth = yield* credential(connection);
    const now = yield* Clock.currentTimeMillis;
    const pending = yield* store.pending(connection.generation, now);
    for (const delivery of pending) {
      if (delivery.request !== null) {
        const request = delivery.request;
        const projection = yield* threads
          .getThreadRecords(request.threadId, ["runtimeRequests"], {
            runtimeRequestStatuses: ["pending"],
          })
          .pipe(
            Effect.catchTags({
              OrchestratorProjectionError: (cause) =>
                isMissingThread(cause.cause) ? Effect.succeed(null) : Effect.fail(cause),
            }),
            Effect.mapError(() => fail("storage")),
          );
        if (
          !projection?.runtimeRequests.some(
            (current) => current.id === request.requestId && current.status === "pending",
          )
        ) {
          yield* store.discardRequest(connection.generation, request.requestId);
          continue;
        }
      }
      yield* store.updateDelivery(delivery.id, "sending");
      yield* client
        .send(
          { baseUrl: connection.baseUrl, token: auth.token },
          {
            userId: connection.userId,
            ...(auth.contextToken ? { contextToken: auth.contextToken } : {}),
            clientId: delivery.id,
            text: delivery.text,
          },
        )
        .pipe(
          Effect.andThen(store.updateDelivery(delivery.id, "sent")),
          Effect.catchTags({
            WechatError: Effect.fn("WechatBridge.deliveryFailed")(function* (cause) {
              error = cause.reason;
              if (cause.reason === "credentials") runtimeStatus = "reconnect_required";
              yield* store.updateDelivery(
                delivery.id,
                cause.reason === "network"
                  ? "unknown"
                  : delivery.attempts < 2 && cause.reason !== "credentials"
                    ? "pending"
                    : "failed",
                now + 30000,
              );
            }),
          }),
        );
      if (runtimeStatus === "reconnect_required") break;
    }
  });
  const receive = Effect.fn("WechatBridge.receive")(function* () {
    const connection = yield* store.connection;
    if (!connection?.enabled || runtimeStatus === "reconnect_required") return;
    yield* claim();
    if (!connection.userId && (yield* Clock.currentTimeMillis) - connection.enabledAt >= 600000)
      return yield* fail("credentials");
    const auth = yield* credential(connection);
    const result = yield* client.updates(
      { baseUrl: connection.baseUrl, token: auth.token },
      connection.cursor,
    );
    yield* mutex.withPermit(
      Effect.gen(function* () {
        yield* claim();
        let current = yield* store.connection;
        if (!current?.enabled || current.generation !== connection.generation) return;
        if (current.enabledAt !== connection.enabledAt) {
          yield* store.receive(current.generation, [], result.cursor);
          return;
        }
        const enabledAt = current.enabledAt;
        let privateMessages = result.messages.filter(
          (message) =>
            message.message_type === 1 &&
            !message.group_id &&
            message.create_time_ms !== undefined &&
            message.create_time_ms >= enabledAt,
        );
        if (
          !current.userId &&
          auth.bindingCode &&
          (yield* Clock.currentTimeMillis) - current.enabledAt < 600000
        ) {
          const binding = privateMessages.find(
            (message) =>
              message.item_list
                .map((item) => item.text_item?.text ?? "")
                .join("\n")
                .trim() === `/bind ${auth.bindingCode}`,
          );
          if (binding) {
            privateMessages = privateMessages.slice(privateMessages.indexOf(binding));
            current = { ...current, userId: binding.from_user_id };
            yield* store.save(current);
          }
        }
        const userId = current.userId;
        const allowed = privateMessages.filter((message) => message.from_user_id === userId);

        const contextToken = allowed.findLast((message) => message.context_token)?.context_token;
        if (contextToken) yield* saveCredential(current.generation, { ...auth, contextToken });
        yield* store.receive(
          current.generation,
          allowed
            .map((message) => ({
              id: String(message.message_id),
              text: message.item_list
                .flatMap((item) => (item.type === 1 && item.text_item ? [item.text_item.text] : []))
                .join("\n")
                .trim(),
            }))
            .filter((message) => message.text.length > 0 && message.text.length <= 32000),
          result.cursor,
        );
        error = null;
        runtimeStatus = "connected";
        yield* processInbox((yield* store.connection)!);
        yield* publish();
      }),
    );
  });
  const login = Effect.fn("WechatBridge.login")(function* () {
    const active = qr;
    if (!active) return;
    const previous = yield* SubscriptionRef.get(state);
    if ((previous.expiresAt ?? 0) < (yield* Clock.currentTimeMillis)) {
      qr = undefined;
      runtimeStatus = "expired";
      yield* publish();
      return;
    }
    const result = yield* client
      .login({
        baseUrl: active.baseUrl,
        qrcode: active.value,
        ...(active.code ? { code: active.code } : {}),
      })
      .pipe(
        Effect.catchTags({
          WechatError: (cause) => (qr !== active ? Effect.succeed(null) : Effect.fail(cause)),
        }),
      );
    if (!result) return;
    yield* mutex.withPermit(
      Effect.gen(function* () {
        if (qr !== active) return;
        switch (result.status) {
          case "confirmed": {
            if (!result.bot_token || !result.ilink_bot_id) return yield* fail("protocol");
            const baseUrl = yield* Effect.try({
              try: () => Client.wechatApiBase(result.baseurl ?? active.baseUrl),
              catch: () => fail("protocol"),
            });
            const now = yield* Clock.currentTimeMillis;
            const bindingCode = (yield* random.uuidV4())
              .replaceAll("-", "")
              .slice(0, 12)
              .toUpperCase();
            yield* saveCredential(active.generation, {
              token: result.bot_token,
              ...(!result.ilink_user_id ? { bindingCode } : {}),
            });
            yield* store.save({
              generation: active.generation,
              botId: result.ilink_bot_id,
              userId: result.ilink_user_id ?? "",
              baseUrl,
              enabled: true,
              activated: false,
              threadId: null,
              projectId: null,
              pushEnabled: true,
              pushAllThreads: false,
              cursor: "",
              sequence: yield* latestSequence,
              enabledAt: now,
            });
            qr = undefined;
            runtimeStatus = "connected";
            error = null;
            break;
          }
          case "scaned_but_redirect":
            if (result.redirect_host)
              qr = {
                ...active,
                baseUrl: yield* Effect.try({
                  try: () => Client.wechatApiBase(`https://${result.redirect_host}`),
                  catch: () => fail("protocol"),
                }),
              };
            break;
          case "scaned":
            runtimeStatus = "scanned";
            active.code = undefined;
            break;
          case "need_verifycode":
            runtimeStatus = "verify";
            active.code = undefined;
            break;
          case "expired":
          case "verify_code_blocked":
          case "binded_redirect":
            qr = undefined;
            runtimeStatus = "expired";
            break;
          default:
            runtimeStatus = "waiting";
        }
        yield* publish();
      }),
    );
  });
  const onEvent = Effect.fn("WechatBridge.onEvent")(function* (stored: OrchestrationV2StoredEvent) {
    yield* mutex.withPermit(
      Effect.gen(function* () {
        const connection = yield* store.connection;
        if (
          !connection?.enabled ||
          !connection.pushEnabled ||
          stored.sequence <= connection.sequence
        )
          return;
        yield* claim();
        const event = stored.event;
        if (event.type === "runtime-request.updated" && event.payload.status !== "pending") {
          yield* store.discardRequest(connection.generation, event.payload.id);
        }
        if (
          ((event.type === "run.updated" && Threads.isTerminalRunStatus(event.payload.status)) ||
            (event.type === "runtime-request.updated" &&
              event.payload.status === "pending" &&
              event.payload.kind !== "dynamic_tool_call" &&
              event.payload.kind !== "auth_refresh")) &&
          connection.projectId &&
          (connection.pushAllThreads || event.threadId === connection.threadId)
        ) {
          const projection = yield* threads
            .getThreadRecords(
              event.threadId,
              event.type === "runtime-request.updated" ? ["runtimeRequests"] : [],
              { runtimeRequestStatuses: ["pending"] },
            )
            .pipe(
              Effect.catchTags({
                OrchestratorProjectionError: (cause) =>
                  isMissingThread(cause.cause) ? Effect.succeed(null) : Effect.fail(cause),
              }),
              Effect.mapError(() => fail("storage")),
            );
          if (
            projection &&
            projection.thread.projectId === connection.projectId &&
            projection.thread.archivedAt === null &&
            projection.thread.deletedAt === null &&
            projection.thread.lineage.relationshipToParent !== "subagent" &&
            !projection.thread.lineage.sideChat &&
            (event.type === "run.updated" ||
              projection.runtimeRequests.some(
                (request) => request.id === event.payload.id && request.status === "pending",
              )) &&
            (connection.pushAllThreads || event.threadId === connection.threadId)
          ) {
            const runId = event.type === "run.updated" ? event.payload.id : event.runId;
            const records = yield* threads
              .getProjectThreadRecords(
                { projectId: projection.thread.projectId, threadId: event.threadId },
                ["messages"],
                { messageRunIds: runId === undefined ? [] : [runId] },
              )
              .pipe(Effect.mapError(() => fail("target")));
            const finalText = records.messages
              .filter((message) => message.runId === runId && message.role === "assistant")
              .map((message) => message.text)
              .join("\n\n");
            const statusText =
              event.type === "runtime-request.updated"
                ? "任务等待确认，请回到 T3 处理"
                : event.payload.status === "completed"
                  ? "任务完成"
                  : event.payload.status === "failed"
                    ? "任务失败，请在 T3 查看详情"
                    : "任务已停止";
            yield* enqueue(
              connection,
              event.type === "run.updated"
                ? `run:${event.payload.id}:${event.payload.status}`
                : `request:${event.payload.id}`,
              `${records.thread.title}\n${statusText}${finalText ? `\n\n${finalText}` : ""}`,
              event.type === "runtime-request.updated"
                ? { threadId: event.threadId, requestId: event.payload.id }
                : undefined,
            );
          }
        }
        yield* store.save({ ...connection, sequence: stored.sequence });
        yield* publish();
      }),
    );
  });
  const send = Effect.fn("WechatBridge.send")(function* (text: string) {
    yield* mutex.withPermit(
      Effect.gen(function* () {
        yield* claim();
        const connection = yield* store.connection;
        if (!connection?.enabled || !connection.activated) return yield* fail("unpaired");
        const id = yield* random.uuidV4().pipe(Effect.mapError(() => fail("storage")));
        yield* enqueue(connection, `push:${id}`, text);
        yield* publish();
      }),
    );
  });
  const report = Effect.fn("WechatBridge.report")(function* (cause: WechatError) {
    error = cause.reason;
    if (cause.reason === "credentials") runtimeStatus = "reconnect_required";
    else if (!qr) runtimeStatus = "offline";
    yield* publish().pipe(Effect.ignore);
  });
  const mutate = Effect.fn("WechatBridge.mutate")(function* (input: WechatMutation) {
    if (input.type === "test")
      return yield* send(
        "T3 Code 微信主动推送测试：连接正常。定时任务和会话结果可持续发送到此对话。",
      );
    yield* mutex.withPermit(
      Effect.gen(function* () {
        yield* claim();
        const connection = yield* store.connection;
        if (input.type === "cancel") {
          error = null;
          qr = undefined;
          runtimeStatus = undefined;
        } else if (input.type === "unlink") {
          qr = undefined;
          if (polling) yield* Fiber.interrupt(polling);
          if (connection)
            yield* secrets
              .remove(secretName(connection.generation))
              .pipe(Effect.mapError(() => fail("storage")));
          yield* store.clear;
          runtimeStatus = undefined;
          error = null;
        } else if (input.type === "connect") {
          if (connection) return yield* fail("busy");
          const code = yield* client.begin;
          const generation = yield* random.uuidV4().pipe(Effect.mapError(() => fail("storage")));
          qr = { value: code.qrcode, baseUrl: "https://ilinkai.weixin.qq.com", generation };
          runtimeStatus = "waiting";
          error = null;
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            qrCode: code.qrcode_img_content,
            expiresAt: null,
          }));
          const expiresAt = (yield* Clock.currentTimeMillis) + 300000;
          yield* SubscriptionRef.update(state, (value) => ({ ...value, expiresAt }));
        } else if (input.type === "verify") {
          if (!qr) return yield* fail("unpaired");
          qr = { ...qr, code: input.code };
          runtimeStatus = "scanned";
        } else {
          if (!connection) return yield* fail("unpaired");
          if (input.type === "enabled") {
            if (!input.enabled && polling) yield* Fiber.interrupt(polling);
            yield* store.pause(connection.generation);
            yield* store.save({
              ...connection,
              enabled: input.enabled,
              enabledAt: yield* Clock.currentTimeMillis,
              sequence: yield* latestSequence,
            });
            runtimeStatus = input.enabled ? "connected" : "offline";
            error = null;
          } else if (input.type === "configure") {
            const projection = yield* threads
              .getThreadRecords(input.threadId, [])
              .pipe(Effect.mapError(() => fail("target")));
            if (
              !projection ||
              projection.thread.archivedAt !== null ||
              projection.thread.deletedAt !== null ||
              projection.thread.lineage.relationshipToParent === "subagent"
            )
              return yield* fail("target");
            yield* store.pause(connection.generation);
            yield* store.save({
              ...connection,
              threadId: input.threadId,
              projectId: projection.thread.projectId,
              pushEnabled: input.pushEnabled,
              pushAllThreads: input.pushAllThreads,
              enabledAt: yield* Clock.currentTimeMillis,
              sequence: yield* latestSequence,
            });
          } else if (input.type === "retry") {
            const delivery = (yield* store.deliveries(connection.generation)).find(
              (row) => row.id === input.deliveryId,
            );
            if (!delivery || !["failed", "unknown"].includes(delivery.status))
              return yield* fail("target");
            yield* store.updateDelivery(delivery.id, "pending");
          }
        }
        yield* publish();
      }),
    );
  }, Effect.tapError(report));
  const cycle = Effect.fn("WechatBridge.cycle")(function* () {
    const current = yield* store.connection;
    if (!qr && (!current?.enabled || runtimeStatus === "reconnect_required")) return;
    yield* claim();
    if (qr) yield* login();
    yield* mutex.withPermit(
      Effect.gen(function* () {
        const connection = yield* store.connection;
        if (!connection?.enabled || runtimeStatus === "reconnect_required") return;
        yield* credential(connection);
        yield* processInbox(connection);
        yield* sendPending((yield* store.connection)!);
        yield* publish();
      }),
    );
  });
  const start = Effect.gen(function* () {
    if (started) return;
    started = true;
    yield* publish().pipe(Effect.catchTags({ WechatError: report }));
    yield* Effect.addFinalizer(() => store.release(owner).pipe(Effect.ignore));
    yield* Effect.forever(
      cycle().pipe(
        Effect.catchTags({ WechatError: report }),
        Effect.andThen(Effect.sleep("2 seconds")),
      ),
    ).pipe(Effect.forkScoped);
    yield* Effect.forever(
      Effect.gen(function* () {
        polling = yield* receive().pipe(Effect.forkScoped);
        const result = yield* Fiber.await(polling);
        if (Exit.isFailure(result)) {
          const error = Cause.findErrorOption(result.cause);
          if (Option.isSome(error)) yield* report(error.value);
        }
        yield* Effect.sleep("2 seconds");
      }),
    ).pipe(Effect.forkScoped);
    yield* Effect.forever(
      Effect.gen(function* () {
        const connection = yield* store.connection;
        yield* events
          .stream({
            eventType: ["run.updated", "runtime-request.updated"],
            afterSequence: connection?.sequence ?? (yield* latestSequence),
          })
          .pipe(
            Stream.runForEach(onEvent),
            Effect.mapError(() => fail("storage")),
            Effect.catchTags({ WechatError: report }),
          );
        yield* Effect.sleep("5 seconds");
      }),
    ).pipe(Effect.forkScoped);
  });
  return WechatBridge.of({
    subscribe: Stream.unwrap(
      Effect.gen(function* () {
        const available = yield* threads
          .listProjectThreads({ includeSubagents: false })
          .pipe(Effect.mapError(() => fail("target")));
        yield* SubscriptionRef.update(state, (value) => ({
          ...value,
          targets: available.slice(0, 500).map((thread) => ({
            threadId: thread.id,
            projectId: thread.projectId,
            title: thread.title,
          })),
        }));
        yield* publish();
        return SubscriptionRef.changes(state);
      }),
    ),
    mutate,
    send,
    start: start.pipe(Effect.provideService(Scope.Scope, scope)),
  });
});
export const layer = Layer.effect(WechatBridge, make).pipe(Layer.provide(Store.layer));

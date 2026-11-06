import * as Deferred from "effect/Deferred";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  WechatError,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Bridge from "./WechatBridge.ts";
import * as Client from "./WechatClient.ts";
import * as Store from "./WechatStore.ts";

const layerTest = Store.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeCrypto.layer),
);

const connection: Store.Connection = {
  generation: "test",
  botId: "bot",
  userId: "user",
  baseUrl: "https://ilinkai.weixin.qq.com",
  threadId: ThreadId.make("thread"),
  projectId: ProjectId.make("project"),
  enabled: true,
  activated: true,
  pushEnabled: true,
  pushAllThreads: false,
  cursor: "",
  sequence: 0,
  enabledAt: 0,
};
const records = {
  thread: {
    id: connection.threadId,
    projectId: connection.projectId,
    title: "Test thread",
    archivedAt: null,
    deletedAt: null,
    lineage: { relationshipToParent: "root" },
  },
  runs: [],
  messages: [{ runId: "run", role: "assistant", text: "Final result" }],
} as unknown as OrchestrationV2ThreadProjection;

const setup = Effect.fn("WechatBridgeTest.setup")(function* (options?: {
  failSend?: boolean;
  inbound?: boolean;
  binding?: boolean;
  nested?: boolean;
  pendingLogin?: boolean;
}) {
  const loginStarted = yield* Queue.unbounded<void>();
  const loginGate = yield* Deferred.make<never, WechatError>();
  const sent = yield* Queue.unbounded<string>();
  const dispatched = yield* Queue.unbounded<{
    commandId: CommandId;
    messageId: MessageId;
    text: string;
  }>();
  const eventQueue = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const received = yield* Queue.unbounded<number>();
  const bytes = new Map<string, Uint8Array>();
  const secretLayer = Layer.mock(Secrets.ServerSecretStore)({
    get: (key) => Effect.succeed(Option.fromUndefinedOr(bytes.get(key))),
    set: (key, value) =>
      Effect.sync(() => {
        bytes.set(key, value);
      }),
    remove: (key) =>
      Effect.sync(() => {
        bytes.delete(key);
      }),
  });
  let polls = 0;
  const clientLayer = Layer.succeed(Client.WechatClient, {
    begin: Effect.succeed({ qrcode: "qr", qrcode_img_content: "https://liteapp.weixin.qq.com/qr" }),
    login: () =>
      options?.pendingLogin
        ? Queue.offer(loginStarted, undefined).pipe(Effect.andThen(Deferred.await(loginGate)))
        : Effect.succeed({
            status: "confirmed",
            bot_token: "token",
            ilink_bot_id: "bot",
            ilink_user_id: "user",
          }),
    updates: () =>
      Effect.gen(function* () {
        yield* Queue.offer(received, ++polls);
        if (!options?.inbound || polls > 1) return yield* Effect.never;
        return {
          messages: [
            {
              message_id: 1,
              from_user_id: "stranger",
              create_time_ms: 1,
              message_type: 1,
              item_list: [{ type: 1, text_item: { text: "unauthorized" } }],
            },
            {
              message_id: 2,
              from_user_id: "user",
              create_time_ms: 1,
              message_type: 1,
              context_token: "new-context",
              item_list: [
                { type: 1, text_item: { text: options?.binding ? "/bind VERIFY" : "authorized" } },
              ],
            },
          ],
          cursor: "after",
        };
      }),
    send: (_account, input) =>
      Queue.offer(sent, input.text).pipe(
        Effect.andThen(
          options?.failSend ? Effect.fail(new WechatError({ reason: "network" })) : Effect.void,
        ),
      ),
  });
  const threadLayer = Layer.mock(Threads.ThreadManagementService)({
    getProjectThreadRecords: () =>
      Effect.succeed(
        options?.nested
          ? {
              ...records,
              thread: {
                ...records.thread,
                lineage: { ...records.thread.lineage, relationshipToParent: "subagent" as const },
              },
            }
          : records,
      ),
    getThreadRecords: () =>
      Effect.succeed(
        options?.nested
          ? {
              ...records,
              thread: {
                ...records.thread,
                lineage: { ...records.thread.lineage, relationshipToParent: "subagent" as const },
              },
            }
          : records,
      ),
    listProjectThreads: () => Effect.succeed([]),
    sendToThread: (input) => Queue.offer(dispatched, input).pipe(Effect.as({} as never)),
  });
  const eventLayer = Layer.mock(Events.EventSinkV2)({
    latestSequence: () => Effect.succeed(0),
    stream: () => Stream.fromQueue(eventQueue),
  });
  const deps = Layer.mergeAll(secretLayer, clientLayer, threadLayer, eventLayer);
  const store = yield* Store.WechatStore;
  yield* store.save(connection);
  bytes.set(
    "wechat-test",
    new TextEncoder().encode('{"token":"token","contextToken":"previous-context"}'),
  );
  return {
    sent,
    loginStarted,
    loginGate,
    dispatched,
    received,
    bytes,
    eventQueue,
    store,
    layer: Bridge.layer.pipe(Layer.provide(deps)),
  };
});

it.effect("rejects other senders and dispatches a durable message once across replay", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ inbound: true });
    yield* Effect.gen(function* () {
      const bridge = yield* Bridge.WechatBridge;
      yield* bridge.start;
      const input = yield* Queue.take(fixture.dispatched);
      assert.equal(input.text, "authorized");
      assert.equal(input.commandId, "wechat:test:2");
      assert.isTrue(
        new TextDecoder().decode(fixture.bytes.get("wechat-test")).includes("new-context"),
      );
      yield* TestClock.adjust("2 seconds");
      yield* Queue.take(fixture.sent);
      yield* fixture.store.receive("test", [{ id: "2", text: "authorized" }], "after");
      assert.equal((yield* fixture.store.inbox("test")).length, 0);
      assert.equal(yield* Queue.size(fixture.dispatched), 0);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect.each(["user", ""])(
  "does not dispatch persisted messages without credentials (%s)",
  (userId) =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      yield* fixture.store.save({ ...connection, userId });
      yield* fixture.store.receive("test", [{ id: "pending", text: "run task" }], "after");
      fixture.bytes.clear();
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.WechatBridge;
        yield* bridge.start;
        yield* bridge.subscribe.pipe(
          Stream.filter((state) => state.status === "reconnect_required"),
          Stream.take(1),
          Stream.runDrain,
        );
        assert.equal(yield* Queue.size(fixture.dispatched), 0);
        assert.equal((yield* fixture.store.inbox("test")).length, 1);
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect("does not execute the first activation message after an interrupted acceptance", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    yield* fixture.store.save({ ...connection, activationMessageId: "test:first" });
    yield* fixture.store.receive("test", [{ id: "first", text: "hello" }], "after");
    yield* Effect.gen(function* () {
      const bridge = yield* Bridge.WechatBridge;
      yield* bridge.start;
      const text = yield* Queue.take(fixture.sent);
      assert.include(text, "微信已连接");
      assert.equal(yield* Queue.size(fixture.dispatched), 0);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect(
  "marks ambiguous proactive delivery unknown without rerunning or automatically resending",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ failSend: true });
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.WechatBridge;
        yield* bridge.send("Proactive result");
        yield* bridge.start;
        assert.equal(yield* Queue.take(fixture.sent), "Proactive result");
        yield* TestClock.adjust("2 seconds");
        assert.equal((yield* fixture.store.deliveries("test"))[0]?.status, "unknown");
        assert.equal(yield* Queue.size(fixture.sent), 0);
        assert.equal(yield* Queue.size(fixture.dispatched), 0);
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect(
  "can resume polling after pause and removes credentials and queued pushes when unlinked",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.WechatBridge;
        yield* bridge.start;
        assert.equal(yield* Queue.take(fixture.received), 1);
        yield* bridge.mutate({ type: "enabled", enabled: false });
        yield* bridge.mutate({ type: "enabled", enabled: true });
        yield* TestClock.adjust("2 seconds");
        assert.equal(yield* Queue.take(fixture.received), 2);
        yield* bridge.send("later");
        yield* bridge.mutate({ type: "unlink" });
        assert.isNull(yield* fixture.store.connection);
        assert.equal(fixture.bytes.size, 0);
        assert.equal((yield* fixture.store.deliveries("test")).length, 0);
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect(
  "pushes terminal results after a long idle interval and does not redeliver replayed events",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.WechatBridge;
        yield* TestClock.adjust("25 hours");
        yield* bridge.start;
        yield* Queue.take(fixture.received);
        const terminal = {
          sequence: 1,
          event: {
            type: "run.updated",
            threadId: connection.threadId,
            payload: { id: "run", status: "completed" },
          },
        } as OrchestrationV2StoredEvent;
        yield* Queue.offer(fixture.eventQueue, terminal);
        yield* TestClock.adjust("2 seconds");
        const text = yield* Queue.take(fixture.sent);
        assert.include(text, "Final result");
        assert.equal((yield* fixture.store.connection)?.sequence, 1);
        yield* Queue.offer(fixture.eventQueue, terminal);
        yield* TestClock.adjust("2 seconds");
        assert.equal(yield* Queue.size(fixture.sent), 0);
        assert.equal(yield* Queue.size(fixture.dispatched), 0);
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect("requires the one-time binding code when QR login has no scanner identity", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ inbound: true, binding: true });
    yield* fixture.store.save({ ...connection, userId: "", activated: false });
    fixture.bytes.set(
      "wechat-test",
      new TextEncoder().encode('{"token":"token","bindingCode":"VERIFY"}'),
    );
    yield* Effect.gen(function* () {
      const bridge = yield* Bridge.WechatBridge;
      yield* bridge.start;
      yield* TestClock.adjust("2 seconds");
      assert.include(yield* Queue.take(fixture.sent), "微信已连接");
      assert.equal((yield* fixture.store.connection)?.userId, "user");
      assert.equal(yield* Queue.size(fixture.dispatched), 0);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect("does not forward private subagent results when project-wide push is enabled", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ nested: true });
    yield* fixture.store.save({ ...connection, pushAllThreads: true });
    yield* Effect.gen(function* () {
      const bridge = yield* Bridge.WechatBridge;
      yield* bridge.start;
      yield* Queue.take(fixture.received);
      yield* Queue.offer(fixture.eventQueue, {
        sequence: 1,
        event: {
          type: "run.updated",
          threadId: connection.threadId,
          payload: { id: "run", status: "completed" },
        },
      } as OrchestrationV2StoredEvent);
      yield* TestClock.adjust("2 seconds");
      assert.equal((yield* fixture.store.connection)?.sequence, 1);
      assert.equal(yield* Queue.size(fixture.sent), 0);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect("takes over after a previous server lease expires instead of stopping its workers", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    assert.isTrue(yield* fixture.store.lease("previous-server", 0));
    yield* Effect.gen(function* () {
      const bridge = yield* Bridge.WechatBridge;
      yield* bridge.start;
      yield* TestClock.adjust("121 seconds");
      assert.equal(yield* Queue.take(fixture.received), 1);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect("skips messages queued before resuming without granting their reply context", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ inbound: true });
    yield* fixture.store.save({ ...connection, enabledAt: 1000 });
    yield* Effect.gen(function* () {
      const bridge = yield* Bridge.WechatBridge;
      yield* bridge.start;
      yield* Queue.take(fixture.received);
      yield* TestClock.adjust("2 seconds");
      assert.equal((yield* fixture.store.connection)?.cursor, "after");
      assert.equal(yield* Queue.size(fixture.dispatched), 0);
      assert.isFalse(
        new TextDecoder().decode(fixture.bytes.get("wechat-test")).includes("new-context"),
      );
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect("ignores an obsolete QR poll failure after pairing is cancelled", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ pendingLogin: true });
    yield* fixture.store.clear;
    yield* Effect.gen(function* () {
      const bridge = yield* Bridge.WechatBridge;
      yield* bridge.mutate({ type: "connect" });
      yield* bridge.start;
      yield* Queue.take(fixture.loginStarted);
      yield* bridge.mutate({ type: "cancel" });
      yield* Deferred.fail(fixture.loginGate, new WechatError({ reason: "network" }));
      yield* TestClock.adjust("2 seconds");
      const [snapshot] = yield* bridge.subscribe.pipe(Stream.take(1), Stream.runCollect);
      assert.equal(snapshot?.status, "unpaired");
      assert.isNull(snapshot?.error);
      assert.isNull(snapshot?.qrCode);
    }).pipe(Effect.provide(fixture.layer));
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

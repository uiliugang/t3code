// @effect-diagnostics nodeBuiltinImport:off - Bridges Playwright's WebSocket transport to the desktop's fds.
/** Playwright needs a CDP WebSocket; the secret loopback endpoint relays desktop debugger frames over bootstrap fds. */
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import {
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  type DesktopBrowserCommand as DesktopBrowserCommandType,
  type PreviewAutomationLoadError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";

import * as ServerConfig from "../config.ts";

const decodeEvent = Schema.decodeUnknownEffect(DesktopBrowserEvent);
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(DesktopBrowserCommand));

export interface DesktopTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

const keyOf = ({ threadId, tabId }: DesktopTabKey) => `${threadId}\u0000${tabId}`;

export class DesktopBrowserChannel extends Context.Service<
  DesktopBrowserChannel,
  {
    readonly available: boolean;
    /** Subscribe before checking so concurrent attaches cannot be missed. */
    readonly awaitAttached: (key: DesktopTabKey, timeout: Duration.Input) => Effect.Effect<boolean>;
    readonly detached: Stream.Stream<DesktopTabKey>;
    readonly attached: Stream.Stream<DesktopTabKey>;
    readonly isAttached: (key: DesktopTabKey) => Effect.Effect<boolean>;
    /** Whether a desktop window draws the tab on screen, which no streamed viewer counts. */
    readonly isShown: (key: DesktopTabKey) => boolean;
    /** Resolves true once the tab is shown, or false on timeout. */
    readonly awaitShown: (key: DesktopTabKey, timeout: Duration.Input) => Effect.Effect<boolean>;
    /** A load failure the desktop saw, possibly before the server connected to the tab. */
    readonly loadFailure: (key: DesktopTabKey) => PreviewAutomationLoadError | undefined;
    readonly endpoint: (key: DesktopTabKey) => Effect.Effect<string, never, Scope.Scope>;
    readonly pointer: (
      key: DesktopTabKey,
      pointer: { readonly phase: "move" | "click"; readonly x: number; readonly y: number },
    ) => Effect.Effect<void>;
    /** Never fails. A failed write means a broken channel; the next backend starts with no turns. */
    readonly turn: (threadId: string, active: boolean) => Effect.Effect<void>;
  }
>()("t3/preview/DesktopBrowserChannel") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const inputFd = config.desktopBrowserFd;
  const controlFd = config.desktopBrowserControlFd;
  const changes = yield* PubSub.unbounded<{ key: DesktopTabKey; attached: boolean }>();
  const attachedTabs = new Map<string, DesktopTabKey>();
  // Missing reports protect desktop tabs until the renderer explicitly marks them hidden.
  const shownTabs = new Map<string, boolean>();
  const shownReports = yield* PubSub.unbounded<string>();
  const loadFailures = new Map<string, PreviewAutomationLoadError>();
  const inbound = new Map<string, Queue.Queue<string>>();
  const writeLock = yield* Semaphore.make(1);

  const openPipe = Effect.fn("DesktopBrowserChannel.openPipe")(function (
    fd: number | undefined,
    writable: boolean,
  ) {
    if (fd === undefined) return Effect.undefined;
    return Effect.acquireRelease(
      Effect.try({
        try: () => new NodeNet.Socket({ fd, readable: true, writable }),
        catch: (cause) => ({ _tag: "DesktopBrowserPipeOpenError" as const, fd, cause }),
      }),
      (stream) => Effect.sync(() => stream.destroy()),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("desktop browser pipe unavailable", { cause }).pipe(Effect.as(undefined)),
      ),
    );
  });
  const readable = yield* openPipe(inputFd, false);
  const writable = yield* openPipe(controlFd, true);

  if (!writable || !readable) {
    readable?.destroy();
    writable?.destroy();
    return DesktopBrowserChannel.of({
      available: false,
      awaitAttached: Effect.fn("DesktopBrowserChannel.awaitAttached")(function () {
        return Effect.succeed(false);
      }),
      detached: Stream.empty,
      attached: Stream.empty,
      isAttached: Effect.fn("DesktopBrowserChannel.isAttached")(function () {
        return Effect.succeed(false);
      }),
      endpoint: Effect.fn("DesktopBrowserChannel.endpoint")(function () {
        return Effect.die("No desktop app is attached to this server.");
      }),
      turn: Effect.fn("DesktopBrowserChannel.turn")(function () {
        return Effect.void;
      }),
      pointer: Effect.fn("DesktopBrowserChannel.pointer")(function () {
        return Effect.void;
      }),
      isShown: () => false,
      awaitShown: Effect.fn("DesktopBrowserChannel.awaitShown")(function () {
        return Effect.succeed(false);
      }),
      loadFailure: () => undefined,
    });
  }

  NodeStream.finished(writable, { writable: false }, (error) =>
    readable.destroy(error ?? undefined),
  );
  writable.resume();
  const available = () => !readable.destroyed && !writable.destroyed;

  const command = (message: DesktopBrowserCommandType) =>
    writeLock.withPermits(1)(
      encodeCommand(message).pipe(
        Effect.flatMap((line) =>
          Effect.callback<void, Error>((resume) => {
            writable.write(`${line}\n`, (error) =>
              resume(error ? Effect.fail(error) : Effect.void),
            );
          }),
        ),
        Effect.tapCause((cause) => Effect.logWarning("desktop browser command failed", { cause })),
      ),
    );

  const detach = Effect.fn("DesktopBrowserChannel.detach")(function (key: DesktopTabKey) {
    const id = keyOf(key);
    attachedTabs.delete(id);
    shownTabs.delete(id);
    loadFailures.delete(id);
    const queue = inbound.get(id);
    return (queue ? Queue.shutdown(queue) : Effect.void).pipe(
      Effect.andThen(PubSub.publish(changes, { key, attached: false })),
    );
  });
  const events = yield* EffectNodeStream.fromReadable<Uint8Array, Error>({
    evaluate: () => readable,
    closeOnDone: true,
    onError: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
    Stream.mapEffect((value) => decodeEvent(value).pipe(Effect.option)),
    Stream.runForEach((decoded) => {
      if (Option.isNone(decoded)) return Effect.void;
      const event = decoded.value;
      const key = { threadId: event.threadId, tabId: event.tabId };
      const id = keyOf(key);
      switch (event.type) {
        case "cdp": {
          const queue = inbound.get(id);
          return queue ? Queue.offer(queue, event.message).pipe(Effect.asVoid) : Effect.void;
        }
        case "attached":
          attachedTabs.set(id, key);
          return PubSub.publish(changes, { key, attached: true });
        case "loadFailed":
          loadFailures.set(id, {
            url: event.url.slice(0, 2048),
            code: event.code,
            description: event.description,
          });
          return Effect.void;
        case "detached":
          return detach(key);
        case "shown":
          shownTabs.set(id, event.shown);
          return event.shown ? PubSub.publish(shownReports, id) : Effect.void;
      }
    }),
    Effect.catchCause((cause) => Effect.logWarning("desktop browser channel stopped", { cause })),
    Effect.ensuring(
      Effect.gen(function* () {
        writable.destroy();
        yield* Effect.forEach(attachedTabs.values(), detach, { discard: true });
        shownTabs.clear();
        loadFailures.clear();
      }),
    ),
    Effect.forkScoped,
  );

  const endpoint = Effect.fn("DesktopBrowserChannel.endpoint")(function* (key: DesktopTabKey) {
    const id = keyOf(key);
    const secret = NodeCrypto.randomBytes(24).toString("base64url");
    const server = yield* NodeSocketServer.makeWebSocket({
      host: "127.0.0.1",
      port: 0,
      path: `/${secret}`,
    }).pipe(Effect.orDie);
    const queue = yield* Queue.unbounded<string>();
    inbound.set(id, queue);
    // A detach before this registration shut down no queue, so check again.
    if (!attachedTabs.has(id)) {
      inbound.delete(id);
      return yield* Effect.die("The desktop tab detached before the server connected.");
    }
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (inbound.get(id) === queue) inbound.delete(id);
        yield* Queue.shutdown(queue);
        yield* command({ type: "release", ...key }).pipe(Effect.ignore);
      }),
    );
    // The relay serves one Playwright connection; a second would see the first's sessions.
    let connected = false;
    yield* server
      .run((socket) =>
        Effect.gen(function* () {
          if (connected) return;
          connected = true;
          const writer = yield* socket.writer;
          const reader = yield* socket.reader;
          // A detach shuts the queue down. Ending here closes the socket, so Playwright's
          // pending commands fail instead of waiting forever for the tab to answer.
          const toPlaywright = Stream.fromQueue(queue).pipe(
            Stream.runForEach((message) => writer.write(message)),
            Effect.exit,
          );
          const decoder = new TextDecoder();
          const toDesktop = reader.pull.pipe(
            Effect.flatMap((frames) =>
              Effect.forEach(
                frames,
                (frame) =>
                  command({
                    type: "cdp",
                    ...key,
                    message: typeof frame === "string" ? frame : decoder.decode(frame),
                  }),
                { discard: true },
              ),
            ),
            Effect.forever,
          );
          return yield* Effect.raceFirst(toPlaywright, toDesktop);
        }).pipe(Effect.scoped, Effect.ignore),
      )
      .pipe(Effect.forkScoped);
    const address = server.address;
    if (address._tag !== "InetAddressV4") return yield* Effect.die("Unexpected relay address.");
    return `ws://127.0.0.1:${address.port}/${secret}`;
  });

  const isShown = (key: DesktopTabKey) => shownTabs.get(keyOf(key)) ?? true;

  return DesktopBrowserChannel.of({
    get available() {
      return available();
    },
    awaitAttached: Effect.fn("DesktopBrowserChannel.awaitAttached")(function (key, timeout) {
      return Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          if (!available()) return false;
          if (attachedTabs.has(keyOf(key))) return true;
          return yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.attached && keyOf(change.key) === keyOf(key)),
            Stream.interruptWhen(Fiber.await(events)),
            Stream.runHead,
            Effect.map(Option.isSome),
            Effect.timeoutOption(timeout),
            Effect.map((result) => Option.getOrElse(result, () => false)),
          );
        }),
      );
    }),
    detached: Stream.fromPubSub(changes).pipe(
      Stream.filter((change) => !change.attached),
      Stream.map((change) => change.key),
    ),
    attached: Stream.fromPubSub(changes).pipe(
      Stream.filter((change) => change.attached),
      Stream.map((change) => change.key),
    ),
    isAttached: Effect.fn("DesktopBrowserChannel.isAttached")(function (key) {
      return Effect.sync(() => attachedTabs.has(keyOf(key)));
    }),
    isShown,
    awaitShown: Effect.fn("DesktopBrowserChannel.awaitShown")(function (key, timeout) {
      return Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(shownReports);
          if (!available()) return false;
          if (isShown(key)) return true;
          return yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((id) => id === keyOf(key)),
            Stream.interruptWhen(Fiber.await(events)),
            Stream.runHead,
            Effect.map(Option.isSome),
            Effect.timeoutOption(timeout),
            Effect.map((result) => Option.getOrElse(result, () => false)),
          );
        }),
      );
    }),
    loadFailure: (key) => loadFailures.get(keyOf(key)),
    endpoint,
    turn: Effect.fn("DesktopBrowserChannel.turn")(function (threadId, active) {
      return available()
        ? command({ type: "turn", threadId, active }).pipe(Effect.ignore)
        : Effect.void;
    }),
    pointer: Effect.fn("DesktopBrowserChannel.pointer")(function (key, pointer) {
      return available()
        ? command({ type: "pointer", ...key, ...pointer }).pipe(Effect.ignore)
        : Effect.void;
    }),
  });
});

export const layer = Layer.effect(DesktopBrowserChannel, make);

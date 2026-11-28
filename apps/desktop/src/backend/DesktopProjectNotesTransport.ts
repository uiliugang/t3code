import {
  DESKTOP_PROJECT_NOTES_FRAME_MAX_BYTES,
  DESKTOP_PROJECT_NOTES_PROTOCOL_VERSION as version,
  DesktopProjectNotesReply,
  DesktopProjectNotesRequest,
  type DesktopProjectNotesCall,
  type DesktopProjectNotesOutcome,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

const unavailable: DesktopProjectNotesOutcome = { ok: false, failure: { reason: "unavailable" } };
const encode = Schema.encodeEffect(Schema.fromJsonString(DesktopProjectNotesRequest));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopProjectNotesReply), {
  onExcessProperty: "error",
});
const utf8 = new TextEncoder();
type Pending = {
  readonly id: string;
  readonly method: DesktopProjectNotesCall["_tag"];
  readonly done: Deferred.Deferred<DesktopProjectNotesOutcome>;
};
type State =
  | { readonly type: "waiting" }
  | {
      readonly type: "open";
      readonly environmentId: EnvironmentId;
      readonly pending: Pending | null;
    }
  | { readonly type: "closed" };

export const makeDesktopProjectNotesTransport = Effect.fn("DesktopProjectNotesTransport.make")(
  function* (nonce: string, onRevoked: Effect.Effect<void> = Effect.void) {
    const queue = yield* Queue.bounded<Uint8Array>(2);
    const state = yield* Ref.make<State>({ type: "waiting" });
    const serial = yield* Semaphore.make(1);
    const sequence = yield* Ref.make(0);
    const timedOutThrough = yield* Ref.make(0);
    const frame = (request: DesktopProjectNotesRequest) =>
      encode(request).pipe(
        Effect.map((line) => utf8.encode(`${line}\n`)),
        Effect.option,
      );
    const hello = yield* frame({ _tag: "open", version, nonce });
    if (Option.isSome(hello)) yield* Queue.offer(queue, hello.value);
    const close = Ref.getAndSet(state, { type: "closed" }).pipe(
      Effect.tap((previous) =>
        previous.type === "open"
          ? onRevoked.pipe(
              Effect.ensuring(
                previous.pending !== null
                  ? Deferred.succeed(previous.pending.done, unavailable)
                  : Effect.void,
              ),
            )
          : Effect.void,
      ),
      Effect.andThen(Queue.shutdown(queue)),
      Effect.asVoid,
    );
    const accept = Effect.fn("DesktopProjectNotesTransport.accept")(function* (line: string) {
      const reply = yield* decode(line).pipe(Effect.option);
      const current = yield* Ref.get(state);
      if (current.type === "closed") return;
      if (Option.isNone(reply)) return yield* close;
      if (reply.value._tag === "ready") {
        const environmentId = reply.value.environmentId;
        const opened = yield* Ref.modify(state, (latest): [boolean, State] =>
          latest.type === "waiting"
            ? [true, { type: "open", environmentId, pending: null }]
            : [false, latest],
        );
        if (!opened) yield* close;
        return;
      }
      const receivedId = Number(reply.value.requestId);
      if (
        Number.isSafeInteger(receivedId) &&
        receivedId > 0 &&
        String(receivedId) === reply.value.requestId &&
        receivedId <= (yield* Ref.get(timedOutThrough))
      )
        return;
      if (
        current.type !== "open" ||
        current.pending === null ||
        current.pending.id !== reply.value.requestId ||
        (reply.value._tag === "result" && reply.value.result._tag !== current.pending.method)
      )
        return yield* close;
      const outcome: DesktopProjectNotesOutcome =
        reply.value._tag === "result"
          ? { ok: true, result: reply.value.result }
          : { ok: false, failure: reply.value.failure };
      yield* Deferred.succeed(current.pending.done, outcome);
    });
    const status = Ref.get(state).pipe(
      Effect.map((current) => (current.type === "open" ? current.environmentId : null)),
    );
    const call = Effect.fn("DesktopProjectNotesTransport.call")(
      function* (
        environmentId: EnvironmentId,
        request: DesktopProjectNotesCall,
      ): Effect.fn.Return<DesktopProjectNotesOutcome> {
        const current = yield* Ref.get(state);
        if (current.type !== "open" || current.environmentId !== environmentId) return unavailable;
        const id = String(yield* Ref.updateAndGet(sequence, (value) => value + 1));
        const payload = yield* frame({ _tag: "call", version, requestId: id, call: request });
        if (Option.isNone(payload) || payload.value.length > DESKTOP_PROJECT_NOTES_FRAME_MAX_BYTES)
          return { ok: false, failure: { reason: "too-large" } };
        const done = yield* Deferred.make<DesktopProjectNotesOutcome>();
        const installed = yield* Ref.modify(state, (latest): [boolean, State] =>
          latest.type === "open" &&
          latest.environmentId === environmentId &&
          latest.pending === null
            ? [true, { ...latest, pending: { id, method: request._tag, done } }]
            : [false, latest],
        );
        if (!installed) return unavailable;
        // A timed-out write may have committed. Keep the pipe so a retry can replay its mutation ID.
        return yield* Queue.offer(queue, payload.value).pipe(
          Effect.andThen(Deferred.await(done)),
          Effect.timeoutOrElse({
            duration: "6 seconds",
            orElse: () => Ref.set(timedOutThrough, Number(id)).pipe(Effect.as(unavailable)),
          }),
          Effect.onInterrupt(() => close),
          Effect.ensuring(
            Ref.update(state, (latest) =>
              latest.type === "open" && latest.pending?.id === id
                ? { ...latest, pending: null }
                : latest,
            ),
          ),
        );
      },
      (effect) =>
        serial
          .withPermitsIfAvailable(1)(effect)
          .pipe(Effect.map(Option.getOrElse(() => unavailable))),
    );
    return { outgoing: Stream.fromQueue(queue), accept, call, status, close };
  },
);
export type DesktopProjectNotesTransport = Effect.Success<
  ReturnType<typeof makeDesktopProjectNotesTransport>
>;

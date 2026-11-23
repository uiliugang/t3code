import {
  DESKTOP_PROJECT_NOTES_FRAME_MAX_BYTES,
  DESKTOP_PROJECT_NOTES_PROTOCOL_VERSION as version,
  DesktopProjectNotesReply,
  DesktopProjectNotesRequest,
  type EnvironmentId,
  type DesktopProjectNotesCall,
  type DesktopProjectNotesCallResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  ProjectNotesStore,
  type ProjectNotesOwnerKey,
  type ProjectNotesStoreError,
} from "./ProjectNotesStore.ts";

class DesktopProjectNotesChannelClosed extends Schema.TaggedError<
  DesktopProjectNotesChannelClosed,
  { readonly brand: unique symbol }
>()("DesktopProjectNotesChannelClosed", {}) {}
const close = () => new DesktopProjectNotesChannelClosed();
const nativeDesktopOwner = "local-desktop-owner:v1" as ProjectNotesOwnerKey;
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopProjectNotesRequest), {
  onExcessProperty: "error",
});
const encode = Schema.encodeEffect(Schema.fromJsonString(DesktopProjectNotesReply));
const utf8 = new TextEncoder();

export const makeDesktopProjectNotesSession = Effect.fn("DesktopProjectNotesSession.make")(
  function* (link: { readonly launchNonce: string; readonly environmentId: EnvironmentId }) {
    const store = yield* ProjectNotesStore;
    const state = yield* Ref.make<"waiting" | "open" | "closed">("waiting");
    const serial = yield* Semaphore.make(1);
    const closed = Ref.set(state, "closed");
    const reply = (value: DesktopProjectNotesReply) =>
      encode(value).pipe(
        Effect.mapError(close),
        Effect.flatMap((line) => {
          const bytes = utf8.encode(`${line}\n`);
          return bytes.byteLength <= DESKTOP_PROJECT_NOTES_FRAME_MAX_BYTES
            ? Effect.succeed(bytes)
            : Effect.fail(close());
        }),
      );
    const dispatch = (
      call: DesktopProjectNotesCall,
    ): Effect.Effect<DesktopProjectNotesCallResult, ProjectNotesStoreError> => {
      switch (call._tag) {
        case "get":
          return store
            .get(nativeDesktopOwner, call.input)
            .pipe(Effect.map((value) => ({ _tag: "get", value }) as const));
        case "list":
          return store
            .list(nativeDesktopOwner, call.input)
            .pipe(Effect.map((value) => ({ _tag: "list", value }) as const));
        case "search":
          return store
            .search(nativeDesktopOwner, call.input)
            .pipe(Effect.map((value) => ({ _tag: "search", value }) as const));
        case "create":
          return store
            .create(nativeDesktopOwner, call.input)
            .pipe(Effect.map((value) => ({ _tag: "create", value }) as const));
        case "update":
          return store
            .update(nativeDesktopOwner, call.input)
            .pipe(Effect.map((value) => ({ _tag: "update", value }) as const));
        case "setArchive":
          return store
            .setArchive(nativeDesktopOwner, call.input)
            .pipe(Effect.map((value) => ({ _tag: "setArchive", value }) as const));
      }
    };
    const handle = Effect.fn("DesktopProjectNotesSession.handle")(
      function* (line: string) {
        const current = yield* Ref.get(state);
        if (
          current === "closed" ||
          utf8.encode(line).byteLength >= DESKTOP_PROJECT_NOTES_FRAME_MAX_BYTES
        )
          return yield* close();
        const request = yield* decode(line).pipe(Effect.mapError(close));
        if (request._tag === "open") {
          if (current !== "waiting" || request.nonce !== link.launchNonce) return yield* close();
          yield* Ref.set(state, "open");
          return yield* reply({ _tag: "ready", version, environmentId: link.environmentId });
        }
        if (current !== "open") return yield* close();
        const { requestId, call } = request;
        const result = yield* Effect.result(dispatch(call));
        if (result._tag === "Failure") {
          const { reason, currentRevision } = result.failure;
          return yield* reply({
            _tag: "failure",
            version,
            requestId,
            failure: { reason, ...(currentRevision === undefined ? {} : { currentRevision }) },
          });
        }
        return yield* reply({ _tag: "result", version, requestId, result: result.success });
      },
      (effect) => serial.withPermits(1)(effect.pipe(Effect.tapError(() => closed))),
    );
    return { handle, close: serial.withPermits(1)(closed) };
  },
);

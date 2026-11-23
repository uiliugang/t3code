// @effect-diagnostics nodeBuiltinImport:off - Wraps inherited libuv descriptors; does not bind or listen.
import * as NodeNet from "node:net";
import * as NodeStream from "@effect/platform-node/NodeStream";
import {
  DESKTOP_PROJECT_NOTES_INPUT_FD,
  DESKTOP_PROJECT_NOTES_OUTPUT_FD,
} from "@t3tools/contracts";
import { desktopProjectNotesLines } from "@t3tools/shared/desktopProjectNotesFrames";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeDesktopProjectNotesSession } from "./DesktopProjectNotesSession.ts";
import * as ProjectNotesStore from "./ProjectNotesStore.ts";

class PipeClosed extends Schema.TaggedError<PipeClosed, { readonly brand: unique symbol }>()(
  "DesktopProjectNotesPipeClosed",
  {},
) {}
const close = () => new PipeClosed();
const acquire = Effect.fn("DesktopProjectNotesPipe.acquire")((fd: number, writable: boolean) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const pipe = new NodeNet.Socket({ fd, readable: !writable, writable });
        pipe.on("error", () => {
          pipe.destroy();
        });
        return pipe;
      },
      catch: close,
    }),
    (pipe) =>
      Effect.sync(() => {
        pipe.destroy();
      }),
  ),
);
const send = (socket: NodeNet.Socket, bytes: Uint8Array) =>
  Effect.callback<void, PipeClosed>((resume) => {
    if (socket.destroyed || !socket.writable) {
      resume(Effect.fail(close()));
      return;
    }
    const onClose = () => resume(Effect.fail(close()));
    socket.once("close", onClose);
    socket.once("error", onClose);
    socket.write(bytes, (error) => resume(error ? Effect.fail(close()) : Effect.void));
    return Effect.sync(() => {
      socket.off("close", onClose);
      socket.off("error", onClose);
    });
  }).pipe(Effect.timeoutOrElse({ duration: "4 seconds", orElse: () => Effect.fail(close()) }));
const start = Effect.fn("DesktopProjectNotesPipe.start")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const nonce = config.desktopProjectNotesNonce;
  if (config.mode !== "desktop" || nonce === undefined) return;
  const env = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* env.getEnvironmentId;
  const runtime = Effect.scoped(
    Effect.gen(function* () {
      const incoming = yield* acquire(DESKTOP_PROJECT_NOTES_INPUT_FD, false);
      const outgoing = yield* acquire(DESKTOP_PROJECT_NOTES_OUTPUT_FD, true);
      const session = yield* makeDesktopProjectNotesSession({ launchNonce: nonce, environmentId });
      const input = NodeStream.fromReadable<Uint8Array, PipeClosed>({
        evaluate: () => incoming,
        closeOnDone: true,
        onError: close,
      });
      yield* desktopProjectNotesLines(input).pipe(
        Stream.runForEach((line) =>
          session.handle(line).pipe(Effect.flatMap((reply) => send(outgoing, reply))),
        ),
        Effect.ensuring(session.close),
      );
    }),
  );
  // Do not propagate payloads or codec errors into server logs.
  yield* runtime.pipe(Effect.ignore, Effect.forkScoped);
});
export const layer = Layer.effectDiscard(start()).pipe(Layer.provide(ProjectNotesStore.layer));

import type { LocalNoiseMediaListener } from "@t3tools/contracts";
import type { ApprovedNoiseConnection } from "../platform/capabilities.ts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

class MediaConnectionClosed extends Schema.TaggedError<
  MediaConnectionClosed,
  { readonly brand: unique symbol }
>()("MediaConnectionClosed", {}) {}

const nativeIo = <A>(attempt: () => Promise<A>) =>
  Effect.tryPromise({ try: attempt, catch: () => new MediaConnectionClosed() });

export const openLocalMediaOrigins = Effect.fn("connectNoise.mediaOrigins")(
  function* <E>(
    create: () => Promise<LocalNoiseMediaListener>,
    open: Effect.Effect<ApprovedNoiseConnection, E, Scope.Scope>,
  ) {
    const listener = yield* Effect.acquireRelease(nativeIo(create), (value) =>
      Effect.sync(() => value.release()),
    );
    const serve = Effect.fn("connectNoise.mediaConnection")(
      function* (id: number) {
        yield* Effect.addFinalizer(() => Effect.sync(() => listener.close(id)));
        const { socket } = yield* open;
        const read = yield* socket.reader;
        const write = yield* socket.writer;
        const upload = Effect.gen(function* () {
          while (true) {
            const bytes = yield* nativeIo(() => listener.read(id));
            if (bytes.length === 0) return;
            yield* write.write(bytes);
          }
        });
        const download = Effect.forever(
          read.pull.pipe(
            Effect.flatMap((frames) =>
              Effect.forEach(
                frames,
                (bytes) =>
                  typeof bytes === "string"
                    ? Effect.die("Invalid media record")
                    : nativeIo(() => listener.write(id, bytes)),
                { discard: true },
              ),
            ),
          ),
        );
        yield* Effect.raceFirst(upload, download);
      },
      Effect.scoped,
      (run) => Effect.ignoreCause(run),
    );
    yield* Effect.forever(
      nativeIo(() => listener.accept()).pipe(Effect.flatMap((id) => Effect.forkScoped(serve(id)))),
    ).pipe(Effect.forkScoped);
    return listener.origins;
  },
  Effect.orElseSucceed(() => undefined),
);

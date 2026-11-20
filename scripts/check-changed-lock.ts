// @effect-diagnostics nodeBuiltinImport:off -- SQLite provides a cross-process lock released by the OS on exit.
import * as NodeSqlite from "node:sqlite";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class CheckLockError extends Schema.TaggedError<
  CheckLockError,
  { readonly brand: unique symbol }
>()("CheckLockError", { filename: Schema.String, cause: Schema.Defect() }) {
  override get message() {
    return "Could not acquire the repository check lock.";
  }
}

export const withCheckLock = Effect.fn("checkChanged.withLock")(function* <A, E, R>(
  filename: string,
  task: Effect.Effect<A, E, R>,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const database = yield* Effect.acquireRelease(
        Effect.try({
          try: () => new NodeSqlite.DatabaseSync(filename, { timeout: 0 }),
          catch: (cause) => new CheckLockError({ filename, cause }),
        }),
        (database) => Effect.sync(() => database.close()),
      );
      let reported = false;
      const acquire = Effect.try({
        try: () => {
          try {
            database.exec("BEGIN IMMEDIATE");
            return true;
          } catch (cause) {
            if (cause instanceof Error && "errcode" in cause && cause.errcode === 5) return false;
            throw cause;
          }
        },
        catch: (cause) => new CheckLockError({ filename, cause }),
      });
      while (!(yield* acquire)) {
        if (!reported) {
          yield* Console.log(
            "check:changed: waiting for another check in this repository to finish.",
          );
          reported = true;
        }
        yield* Effect.sleep("1 second");
      }
      return yield* task;
    }),
  );
});

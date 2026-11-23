// @effect-diagnostics nodeBuiltinImport:off -- SQLite provides a cross-process lock released by the OS on exit.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

export class CheckLockError extends Schema.TaggedError<
  CheckLockError,
  { readonly brand: unique symbol }
>()("CheckLockError", { filename: Schema.String, cause: Schema.Defect() }) {
  override get message() {
    return "Could not acquire the repository check lock.";
  }
}

export interface SlotLockOptions {
  readonly slots?: number;
  readonly waitingMessage?: string;
}

const DEFAULT_WAITING_MESSAGE =
  "check:changed: waiting for another check in this repository to finish.";
export const BROWSER_TEST_WAITING_MESSAGE =
  "test:browser:local: waiting for another browser test in this repository to finish.";

const slotFilenames = (filename: string, slots: number): ReadonlyArray<string> => {
  if (slots <= 1) return [filename];
  const parsed = NodePath.parse(filename);
  return Array.from({ length: slots }, (_, index) =>
    NodePath.join(parsed.dir, `${parsed.name}-slot-${index + 1}${parsed.ext}`),
  );
};

const tryAcquireImmediate = (database: NodeSqlite.DatabaseSync, filename: string) =>
  Effect.try({
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

export const withSlotLock = Effect.fn("checkChanged.withSlotLock")(function* <A, E, R>(
  filename: string,
  task: Effect.Effect<A, E, R>,
  options: SlotLockOptions = {},
) {
  const slots = options.slots ?? 1;
  if (!Number.isSafeInteger(slots) || slots < 1) {
    return yield* new CheckLockError({
      filename,
      cause: new RangeError(`Lock slot count must be a positive integer, got ${slots}.`),
    });
  }
  const waitingMessage = options.waitingMessage ?? DEFAULT_WAITING_MESSAGE;
  const filenames = slotFilenames(filename, slots);

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const outerScope = yield* Effect.scope;
      let reported = false;
      while (true) {
        for (const slotFilename of filenames) {
          const slotScope = yield* Scope.make();
          const acquired = yield* Effect.gen(function* () {
            const database = yield* Effect.acquireRelease(
              Effect.try({
                try: () => new NodeSqlite.DatabaseSync(slotFilename, { timeout: 0 }),
                catch: (cause) => new CheckLockError({ filename: slotFilename, cause }),
              }),
              (db) => Effect.sync(() => db.close()),
            );
            return yield* tryAcquireImmediate(database, slotFilename);
          }).pipe(
            Scope.provide(slotScope),
            Effect.onError(() => Scope.close(slotScope, Exit.void)),
          );
          if (acquired) {
            yield* Scope.addFinalizerExit(outerScope, (exit) => Scope.close(slotScope, exit));
            return yield* task;
          }
          yield* Scope.close(slotScope, Exit.void);
        }
        if (!reported) {
          yield* Console.log(waitingMessage);
          reported = true;
        }
        yield* Effect.sleep("1 second");
      }
    }),
  );
});

export const withCheckLock = <A, E, R>(filename: string, task: Effect.Effect<A, E, R>) =>
  withSlotLock(filename, task);

export const browserTestConcurrency = Effect.fn("browserTestLock.concurrency")(function* () {
  const configured = yield* Config.option(Config.Int("T3_BROWSER_TEST_CONCURRENCY")).pipe(
    Effect.mapError(() => "T3_BROWSER_TEST_CONCURRENCY must be a positive integer."),
  );
  if (Option.isSome(configured) && configured.value < 1) {
    return yield* Effect.fail("T3_BROWSER_TEST_CONCURRENCY must be a positive integer.");
  }
  return Option.getOrElse(configured, () => 1);
});

export const withBrowserTestLock = Effect.fn("browserTestLock.withLock")(function* <A, E, R>(
  commonDir: string,
  task: Effect.Effect<A, E, R>,
  options: { readonly waitingMessage?: string } = {},
) {
  const slots = yield* browserTestConcurrency();
  return yield* withSlotLock(NodePath.join(commonDir, "t3-browser-test.sqlite"), task, {
    slots,
    waitingMessage: options.waitingMessage ?? BROWSER_TEST_WAITING_MESSAGE,
  });
});

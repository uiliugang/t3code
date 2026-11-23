// @effect-diagnostics nodeBuiltinImport:off -- SQLite provides a cross-process lock released by the OS on exit.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class CheckLockError extends Schema.TaggedError<
  CheckLockError,
  { readonly brand: unique symbol }
>()("CheckLockError", { filename: Schema.String, cause: Schema.Defect() }) {
  override get message() {
    return `Could not acquire repository lock ${this.filename}: ${String(this.cause)}`;
  }
}

interface SlotLockOptions {
  readonly slots?: number;
  readonly waitingMessage?: string;
}

const DEFAULT_WAITING_MESSAGE =
  "check:changed: waiting for another check in this repository to finish.";
const BROWSER_TEST_WAITING_MESSAGE =
  "test:browser:local: waiting for another browser test in this repository to finish.";

// Slot 1 always uses `filename` so callers with default concurrency=1 and callers
// with T3_BROWSER_TEST_CONCURRENCY>=2 share the first slot instead of bypassing each other.
const slotFilenames = (filename: string, slots: number): ReadonlyArray<string> => {
  if (slots <= 1) return [filename];
  const parsed = NodePath.parse(filename);
  return Array.from({ length: slots }, (_, index) =>
    index === 0
      ? filename
      : NodePath.join(parsed.dir, `${parsed.name}-slot-${index + 1}${parsed.ext}`),
  );
};

const isSqliteBusyOrLocked = (cause: unknown): boolean => {
  if (!(cause instanceof Error) || !("errcode" in cause) || typeof cause.errcode !== "number") {
    return false;
  }
  const primary = cause.errcode & 0xff;
  return primary === 5 || primary === 6;
};

const openAndLockSlot = (filename: string): NodeSqlite.DatabaseSync | null => {
  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    database = new NodeSqlite.DatabaseSync(filename, { timeout: 0 });
    database.exec("BEGIN IMMEDIATE");
    return database;
  } catch (cause) {
    database?.close();
    if (isSqliteBusyOrLocked(cause)) return null;
    throw cause;
  }
};

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

  return yield* Effect.scopedWith((scope) =>
    Effect.gen(function* () {
      let reported = false;
      while (true) {
        for (const slotFilename of filenames) {
          const acquired = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const database = yield* Effect.try({
                try: () => openAndLockSlot(slotFilename),
                catch: (cause) => new CheckLockError({ filename: slotFilename, cause }),
              });
              if (database !== null) {
                yield* Scope.addFinalizer(
                  scope,
                  Effect.sync(() => database.close()),
                );
              }
              return database;
            }),
          );
          if (acquired !== null) {
            return yield* task;
          }
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

const browserTestConcurrency = Effect.fn("browserTestLock.concurrency")(function* () {
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

export const resolveGitCommonDir = Effect.fn("repoLock.gitCommonDir")(function* (
  cwd: string,
  caller = "git",
) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["-c", "core.quotePath=false", "rev-parse", "--git-common-dir"], {
          cwd,
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: 3 },
      );
      if (exitCode !== 0) {
        return yield* Effect.fail(
          `${caller}: git rev-parse --git-common-dir exited with ${exitCode}: ${stderr.trim()}`,
        );
      }
      return path.resolve(cwd, stdout.trim());
    }),
  );
});

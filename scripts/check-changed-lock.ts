// @effect-diagnostics nodeBuiltinImport:off -- SQLite provides a cross-process lock released by the OS on exit; child_process/fs handle POSIX descendant group cleanup.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
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

export interface ProcessSnapshotEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly lstart: string;
}

export interface TrackedProcessGroup {
  readonly pgid: number;
  readonly members: ReadonlyArray<{ readonly pid: number; readonly lstart: string }>;
}

interface ActiveSlotTracker {
  readonly groupsPath: string;
  readonly groups: Map<number, TrackedProcessGroup>;
}

const TrackedProcessGroupSchema = Schema.Struct({
  pgid: Schema.Number,
  members: Schema.Array(Schema.Struct({ pid: Schema.Number, lstart: Schema.String })),
});
const decodePersistedGroups = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(TrackedProcessGroupSchema)),
);

const ActiveSlotTrackerStack = Context.Reference<ReadonlyArray<ActiveSlotTracker>>(
  "t3/scripts/ActiveSlotTrackerStack",
  { defaultValue: () => [] },
);

const groupsSidecarPath = (slotFilename: string) => `${slotFilename}.groups.json`;

const parsePosixProcessSnapshot = (output: string): ReadonlyArray<ProcessSnapshotEntry> => {
  const entries: Array<ProcessSnapshotEntry> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    if (pid > 0 && pgid > 0) {
      entries.push({ pid, ppid, pgid, lstart: match[4]!.trim() });
    }
  }
  return entries;
};

const PS_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,lstart="] as const;
const psEnv = () => ({ ...process.env, LC_ALL: "C", TZ: "UTC" });

// Run `ps` once to capture the process table with UTC start timestamps so
// stale-group cleanup only signals processes whose (pid, lstart) still match.
export const readPosixProcessSnapshot = (
  platform: NodeJS.Platform,
): ReadonlyArray<ProcessSnapshotEntry> => {
  if (platform === "win32") return [];
  try {
    const output = NodeChildProcess.execFileSync("ps", PS_ARGS, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: psEnv(),
    });
    return parsePosixProcessSnapshot(output);
  } catch {
    return [];
  }
};

const readPosixProcessSnapshotAsync = (
  platform: NodeJS.Platform,
): Effect.Effect<ReadonlyArray<ProcessSnapshotEntry>> => {
  if (platform === "win32") return Effect.succeed([]);
  return Effect.callback<ReadonlyArray<ProcessSnapshotEntry>>((resume) => {
    const child = NodeChildProcess.execFile(
      "ps",
      PS_ARGS,
      { encoding: "utf8", env: psEnv() },
      (error, stdout) => {
        resume(Effect.succeed(error ? [] : parsePosixProcessSnapshot(stdout)));
      },
    );
    return Effect.sync(() => {
      child.kill("SIGKILL");
    });
  });
};

const isDescendantOf = (
  pid: number,
  ancestorPid: number,
  byPid: ReadonlyMap<number, ProcessSnapshotEntry>,
): boolean => {
  const seen = new Set<number>();
  let current = byPid.get(pid);
  while (current !== undefined && !seen.has(current.pid)) {
    seen.add(current.pid);
    if (current.ppid === ancestorPid) return true;
    if (current.ppid <= 1) return false;
    current = byPid.get(current.ppid);
  }
  return false;
};

export const collectDescendantProcessGroups = (
  rootPid: number,
  snapshot: ReadonlyArray<ProcessSnapshotEntry>,
  excludePgid?: number,
  requireAncestorPid?: number,
): ReadonlyArray<TrackedProcessGroup> => {
  if (rootPid <= 0) return [];
  const childrenByParent = new Map<number, Array<ProcessSnapshotEntry>>();
  const byPid = new Map<number, ProcessSnapshotEntry>();
  for (const entry of snapshot) {
    byPid.set(entry.pid, entry);
    const list = childrenByParent.get(entry.ppid);
    if (list) list.push(entry);
    else childrenByParent.set(entry.ppid, [entry]);
  }
  if (
    requireAncestorPid !== undefined &&
    rootPid !== requireAncestorPid &&
    !isDescendantOf(rootPid, requireAncestorPid, byPid)
  ) {
    return [];
  }
  const visited = new Set<number>();
  const queue: Array<number> = [rootPid];
  const pgids = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const entry = byPid.get(pid);
    if (entry && entry.pgid > 0 && entry.pgid !== excludePgid) {
      pgids.add(entry.pgid);
    }
    for (const child of childrenByParent.get(pid) ?? []) {
      if (!visited.has(child.pid)) queue.push(child.pid);
    }
  }
  const groups: Array<TrackedProcessGroup> = [];
  for (const pgid of pgids) {
    const members = snapshot
      .filter((entry) => entry.pgid === pgid)
      .map(({ pid, lstart }) => ({ pid, lstart }));
    if (members.length > 0) groups.push({ pgid, members });
  }
  return groups;
};

const sleepSync = (millis: number): void => {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, millis);
};

const verifyLiveGroups = (
  groups: ReadonlyArray<TrackedProcessGroup>,
  live: ReadonlyArray<ProcessSnapshotEntry>,
): ReadonlyArray<TrackedProcessGroup> => {
  const liveByKey = new Set(live.map((entry) => `${entry.pgid}:${entry.pid}:${entry.lstart}`));
  const ownPgid = live.find((entry) => entry.pid === process.pid)?.pgid;
  return groups.filter(
    (group) =>
      group.pgid > 1 &&
      group.pgid !== ownPgid &&
      group.members.some((member) => liveByKey.has(`${group.pgid}:${member.pid}:${member.lstart}`)),
  );
};

export const terminateTrackedProcessGroups = (
  groups: ReadonlyArray<TrackedProcessGroup>,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly graceMs?: number;
    readonly snapshot?: () => ReadonlyArray<ProcessSnapshotEntry>;
    readonly signalGroup?: (pgid: number, signal: NodeJS.Signals | 0) => void;
    readonly wait?: (millis: number) => void;
  } = {},
): void => {
  const platform = options.platform ?? "linux";
  if (platform === "win32" || groups.length === 0) return;
  const readSnapshot = options.snapshot ?? (() => readPosixProcessSnapshot(platform));
  const signalGroup =
    options.signalGroup ??
    ((pgid: number, signal: NodeJS.Signals | 0) => {
      process.kill(-pgid, signal);
    });
  const wait = options.wait ?? sleepSync;
  const graceMs = options.graceMs ?? 2_000;

  // Re-verify against the live process table before signalling so a recycled
  // PID/PGID is never touched.
  const verified = verifyLiveGroups(groups, readSnapshot());
  if (verified.length === 0) return;

  let remaining = verified.filter((group) => {
    try {
      signalGroup(group.pgid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  });
  if (remaining.length === 0) return;

  const pollIntervalMs = 25;
  const maxPolls = Math.ceil(graceMs / pollIntervalMs);
  for (let poll = 0; poll < maxPolls; poll += 1) {
    remaining = remaining.filter((group) => {
      try {
        signalGroup(group.pgid, 0);
        return true;
      } catch {
        // ESRCH means exited; EPERM means we cannot signal it anyway.
        return false;
      }
    });
    if (remaining.length === 0) return;
    wait(pollIntervalMs);
  }

  // Re-verify survivors against a fresh snapshot before SIGKILL so a PGID that
  // exited and was recycled during the grace period is never signalled.
  const stillLive = verifyLiveGroups(remaining, readSnapshot());
  for (const group of stillLive) {
    try {
      signalGroup(group.pgid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
};

const readPersistedGroups = (groupsPath: string): ReadonlyArray<TrackedProcessGroup> => {
  try {
    const content = NodeFS.readFileSync(groupsPath, "utf8");
    return Option.getOrElse(decodePersistedGroups(content), () => []).filter(
      (group) => group.members.length > 0,
    );
  } catch {
    return [];
  }
};

const writePersistedGroups = (
  groupsPath: string,
  groups: ReadonlyMap<number, TrackedProcessGroup>,
): void => {
  const tempPath = `${groupsPath}.${process.pid}.tmp`;
  try {
    if (groups.size === 0) {
      NodeFS.rmSync(groupsPath, { force: true });
      return;
    }
    NodeFS.writeFileSync(tempPath, JSON.stringify([...groups.values()]));
    NodeFS.renameSync(tempPath, groupsPath);
  } catch {
    try {
      NodeFS.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
};

const mergeTrackedGroup = (
  target: Map<number, TrackedProcessGroup>,
  group: TrackedProcessGroup,
): boolean => {
  const existing = target.get(group.pgid);
  if (!existing) {
    target.set(group.pgid, group);
    return true;
  }
  const merged = new Map(existing.members.map((m) => [`${m.pid}:${m.lstart}`, m]));
  let groupChanged = false;
  for (const member of group.members) {
    const key = `${member.pid}:${member.lstart}`;
    if (!merged.has(key)) {
      merged.set(key, member);
      groupChanged = true;
    }
  }
  if (groupChanged) {
    target.set(group.pgid, { pgid: group.pgid, members: [...merged.values()] });
  }
  return groupChanged;
};

const recordGroupsInSlots = (
  trackers: ReadonlyArray<ActiveSlotTracker>,
  groups: ReadonlyArray<TrackedProcessGroup>,
): void => {
  if (groups.length === 0 || trackers.length === 0) return;
  for (const tracker of trackers) {
    let changed = false;
    for (const group of groups) {
      if (mergeTrackedGroup(tracker.groups, group)) changed = true;
    }
    if (changed) writePersistedGroups(tracker.groupsPath, tracker.groups);
  }
};

const forgetGroupsFromSlots = (
  trackers: ReadonlyArray<ActiveSlotTracker>,
  pgids: ReadonlyArray<number>,
): void => {
  if (pgids.length === 0 || trackers.length === 0) return;
  for (const tracker of trackers) {
    let changed = false;
    for (const pgid of pgids) {
      if (tracker.groups.delete(pgid)) changed = true;
    }
    if (changed) writePersistedGroups(tracker.groupsPath, tracker.groups);
  }
};

/** Forward SIGHUP to SIGTERM so `NodeRuntime.runMain` runs interruption finalizers. */
export const installSighupForwarding = Effect.fn("checkChanged.installSighupForwarding")(
  function* () {
    const platform = yield* HostProcess.Platform;
    if (platform === "win32") return;
    let forwarding = false;
    const onSighup = () => {
      if (forwarding) return;
      forwarding = true;
      try {
        process.kill(process.pid, "SIGTERM");
      } catch {
        process.exit(129);
      }
    };
    process.on("SIGHUP", onSighup);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.removeListener("SIGHUP", onSighup);
      }),
    );
  },
);

// Track double-detached descendant groups (e.g. Playwright Chromium), persist them to
// enclosing lock sidecars for SIGKILL recovery, and terminate survivors on scope close.
export const trackDescendantProcessGroups = Effect.fn("checkChanged.trackDescendantProcessGroups")(
  function* (rootPid: number) {
    const platform = yield* HostProcess.Platform;
    if (platform === "win32" || rootPid <= 0) return;
    const enclosingTrackers = yield* ActiveSlotTrackerStack;
    const tracked = new Map<number, TrackedProcessGroup>();

    const recordSnapshot = (snapshot: ReadonlyArray<ProcessSnapshotEntry>) => {
      const ownPgid = snapshot.find((entry) => entry.pid === process.pid)?.pgid;
      const discovered = collectDescendantProcessGroups(rootPid, snapshot, ownPgid, process.pid);
      for (const group of discovered) mergeTrackedGroup(tracked, group);
      recordGroupsInSlots(enclosingTrackers, discovered);
    };

    recordSnapshot(readPosixProcessSnapshot(platform));
    yield* Effect.sleep("1 second").pipe(
      Effect.andThen(readPosixProcessSnapshotAsync(platform)),
      Effect.tap((snapshot) => Effect.sync(() => recordSnapshot(snapshot))),
      Effect.forever,
      Effect.forkScoped,
    );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        recordSnapshot(readPosixProcessSnapshot(platform));
        const groups = [...tracked.values()];
        if (groups.length > 0) {
          terminateTrackedProcessGroups(groups, { platform });
          forgetGroupsFromSlots(
            enclosingTrackers,
            groups.map((group) => group.pgid),
          );
        }
      }),
    );
  },
);

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
  const platform = yield* HostProcess.Platform;
  const outerTrackers = yield* ActiveSlotTrackerStack;

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
              if (database === null) return null;
              const groupsPath = groupsSidecarPath(slotFilename);
              // Reap any detached descendant process groups left behind if the
              // previous lock holder died abruptly (e.g. SIGKILL / parent shell kill).
              const staleGroups = readPersistedGroups(groupsPath);
              if (staleGroups.length > 0) {
                terminateTrackedProcessGroups(staleGroups, { platform });
              }
              const tracker: ActiveSlotTracker = { groupsPath, groups: new Map() };
              writePersistedGroups(groupsPath, tracker.groups);

              yield* Scope.addFinalizer(
                scope,
                Effect.sync(() => {
                  try {
                    if (tracker.groups.size > 0) {
                      terminateTrackedProcessGroups([...tracker.groups.values()], { platform });
                      tracker.groups.clear();
                    }
                    writePersistedGroups(groupsPath, tracker.groups);
                  } finally {
                    database.close();
                  }
                }),
              );
              return tracker;
            }),
          );
          if (acquired !== null) {
            return yield* Effect.provideService(task, ActiveSlotTrackerStack, [
              ...outerTrackers,
              acquired,
            ]);
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
      return path.resolve(cwd, stdout.replace(/\r?\n$/, ""));
    }),
  );
});

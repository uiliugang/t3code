// @effect-diagnostics nodeBuiltinImport:off - realpath.native resolves symlinks before `..` as OS open/lstat do; Effect realPath normalizes `..` lexically first.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class MigrateDevDbSharedHomeError extends Schema.TaggedError<
  MigrateDevDbSharedHomeError,
  { readonly brand: unique symbol }
>()("MigrateDevDbSharedHomeError", {}) {
  override get message(): string {
    return "Refusing to modify a live T3 Code database (such as ~/.t3, T3CODE_HOME, or an installed service home). Use an isolated dev copy.";
  }
}

// Markers written only by installed service or packaged desktop homes.
const STRICT_INSTALLED_MARKERS = [
  ["runtime", "service-state.json"],
  ["runtime", "versions"],
  ["userdata", "logs", "boot-service.log"],
  ["bin", "t3"],
  ["bin", "t3.cmd"],
  ["userdata", "cli-command-first-launch"],
] as const;

// Desktop markers written to `userdata/` by packaged desktop or explicit-T3CODE_HOME desktop.
const DESKTOP_USERDATA_MARKERS = [
  ["userdata", "desktop-settings.json"],
  ["userdata", "desktop-host-scope"],
  ["userdata", "desktop-last-started-version"],
  ["userdata", "connection-catalog.json"],
] as const;

// Additional markers that any live or initialized server home writes, which `--drop-resumable`
// (intended only for freshly copied standalone SQLite seed files) must also refuse.
const DROP_RESUMABLE_EXTRA_MARKERS = [["secrets"], ["settings.json"], ["environment-id"]] as const;

const hasAnyMarker = Effect.fn("hasAnyMarker")(function* (
  baseDir: string,
  markers: ReadonlyArray<readonly [string, ...Array<string>]>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const present = yield* Effect.forEach(markers, (segments) =>
    fs.exists(path.join(baseDir, ...segments)).pipe(Effect.orElseSucceed(() => true)),
  );
  return present.some(Boolean);
});

export const looksLikeInstalledHome = Effect.fn("looksLikeInstalledHome")(function* (
  baseDir: string,
) {
  const path = yield* Path.Path;
  const resolved = path.resolve(baseDir);
  if (yield* hasAnyMarker(resolved, STRICT_INSTALLED_MARKERS)) return true;
  if ((yield* resolveWorktreeT3Home(resolved)) === resolved) return false;
  return yield* hasAnyMarker(resolved, DESKTOP_USERDATA_MARKERS);
});

class NativeRealPathError extends Schema.TaggedError<
  NativeRealPathError,
  { readonly brand: unique symbol }
>()("NativeRealPathError", { cause: Schema.Defect() }) {}

const nativeRealPath = (targetPath: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.realpath(targetPath),
    catch: (cause) => new NativeRealPathError({ cause }),
  });

export const splitPathParentAndLeaf = (
  rawPath: string,
  platform: NodeJS.Platform,
): { readonly parent: string; readonly leaf: string } | undefined => {
  const pathOps = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const separatorPattern = platform === "win32" ? /[\\/]+$/ : /\/+$/;
  const parsedRoot = pathOps.parse(rawPath).root;
  let trimmed = rawPath;
  if (trimmed.length > parsedRoot.length) {
    trimmed = trimmed.replace(separatorPattern, "");
    if (trimmed.length < parsedRoot.length) {
      trimmed = parsedRoot;
    }
  }
  if (trimmed.length === 0 || trimmed === parsedRoot) {
    return undefined;
  }
  const afterRoot = trimmed.slice(parsedRoot.length);
  const slashIndex =
    platform === "win32"
      ? Math.max(afterRoot.lastIndexOf("/"), afterRoot.lastIndexOf("\\"))
      : afterRoot.lastIndexOf("/");
  const leaf = slashIndex === -1 ? afterRoot : afterRoot.slice(slashIndex + 1);
  const parent =
    slashIndex === -1
      ? parsedRoot.length > 0
        ? parsedRoot
        : "."
      : `${parsedRoot}${afterRoot.slice(0, slashIndex)}` || parsedRoot || ".";
  if (leaf === "" || leaf === "..") {
    return undefined;
  }
  if (leaf === "." && parent === trimmed) {
    return undefined;
  }
  return { parent, leaf };
};

export const resolveFilesystemPath = Effect.fn("resolveFilesystemPath")(function* (
  rawPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const direct = yield* nativeRealPath(rawPath).pipe(Effect.option);
  if (Option.isSome(direct)) return direct;
  const missingTail: Array<string> = [];
  let cursor = rawPath;
  while (true) {
    // A dangling symlink or unreadable entry exists at lstat time and must fail closed.
    const cursorStat = yield* fs.lstat(cursor).pipe(
      Effect.as("present" as const),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("missing" as const)),
      Effect.option,
    );
    if (!Option.exists(cursorStat, (state) => state === "missing")) {
      return Option.none<string>();
    }
    const split = splitPathParentAndLeaf(cursor, platform);
    if (split === undefined) {
      return Option.none<string>();
    }
    if (split.leaf !== ".") {
      missingTail.unshift(split.leaf);
    }
    cursor = split.parent;
    const resolvedParent = yield* nativeRealPath(cursor).pipe(Effect.option);
    if (Option.isSome(resolvedParent)) {
      return Option.some(path.join(resolvedParent.value, ...missingTail));
    }
  }
});

// A custom T3CODE_HOME or installed service home holds secrets, settings, or service state beside userdata/statev2.sqlite.
// Unreadable markers count as present so a permission or I/O error never lets a live database pass as a dev copy.
export const looksLikeLiveDatabase = Effect.fn("looksLikeLiveDatabase")(function* (
  databasePath: string,
) {
  const path = yield* Path.Path;
  const rawStateDir = path.dirname(databasePath);
  const resolvedStateDir = yield* nativeRealPath(rawStateDir).pipe(Effect.option);
  if (Option.isNone(resolvedStateDir)) return true;
  const candidateStateDirs = [...new Set([path.resolve(rawStateDir), resolvedStateDir.value])];
  for (const stateDir of candidateStateDirs) {
    if (yield* hasAnyMarker(stateDir, DROP_RESUMABLE_EXTRA_MARKERS)) return true;
    if (path.basename(stateDir).toLowerCase() !== "userdata") continue;
    const baseDir = path.dirname(stateDir);
    if (yield* hasAnyMarker(baseDir, [...STRICT_INSTALLED_MARKERS, ...DESKTOP_USERDATA_MARKERS])) {
      return true;
    }
  }
  return false;
});

const DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

export const databaseFamilyPaths = (databasePath: string): ReadonlyArray<string> =>
  DATABASE_FILE_SUFFIXES.map((suffix) => `${databasePath}${suffix}`);

const stateDatabasePaths = (stateDir: string, path: Path.Path) =>
  ["statev2.sqlite", "state.sqlite", "server-owner.sqlite"].flatMap((name) =>
    databaseFamilyPaths(path.join(stateDir, name)),
  );

const fileIdentity = (info: FileSystem.File.Info) =>
  Option.map(info.ino, (ino) => `${info.dev}:${ino}`);

export const inspectPath = Effect.fn("inspectMigrationPath")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const canonical = yield* resolveFilesystemPath(file);
  if (Option.isNone(canonical)) return yield* new MigrateDevDbSharedHomeError();
  const info = yield* fs.stat(file).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    Effect.mapError(() => new MigrateDevDbSharedHomeError()),
  );
  const identity = Option.flatMap(info, fileIdentity);
  if (Option.isSome(info) && Option.isNone(identity))
    return yield* new MigrateDevDbSharedHomeError();
  return { canonical: canonical.value, identity };
});

export const inspectProtectedHomes = Effect.fn("inspectProtectedMigrationHomes")(function* (
  homes: readonly string[],
  allowedDevHome?: string,
) {
  const path = yield* Path.Path;
  const homeStats = yield* Effect.forEach(homes, inspectPath);
  const stateDirs = homes.flatMap((home, index) => [
    path.join(home, "userdata"),
    ...(homeStats[index]?.canonical === allowedDevHome ? [] : [path.join(home, "dev")]),
  ]);
  const databases = stateDirs.flatMap((dir) => stateDatabasePaths(dir, path));
  return yield* Effect.all({
    homes: Effect.succeed(homeStats),
    stateDirs: Effect.forEach(stateDirs, inspectPath),
    databases: Effect.forEach(databases, inspectPath),
  });
});

export const assertUnlinkedDatabaseFiles = Effect.fn("assertUnlinkedDevDatabaseFiles")(function* (
  files: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  for (const file of files) {
    const info = yield* fs.lstat(file).pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      Effect.mapError(() => new MigrateDevDbSharedHomeError()),
    );
    if (
      Option.exists(
        info,
        (entry) =>
          entry.type !== "File" || !Option.contains(entry.nlink, 1n) || Option.isNone(entry.ino),
      )
    ) {
      return yield* new MigrateDevDbSharedHomeError();
    }
  }
});

export const comparableDevDbPath = (resolved: string, platform: NodeJS.Platform) =>
  platform === "linux" ? resolved : resolved.toLowerCase();

export const expectedDevHomePath = Effect.fn("expectedDevHomePath")(function* (home: string) {
  const path = yield* Path.Path;
  const parent = yield* inspectPath(path.dirname(home));
  return path.join(parent.canonical, path.basename(home));
});

const devHomePathParts = (candidate: string, platform: NodeJS.Platform) => {
  let split = splitPathParentAndLeaf(candidate, platform);
  while (split?.leaf === ".") split = splitPathParentAndLeaf(split.parent, platform);
  return split;
};

export const isDotT3Home = (candidate: string, platform: NodeJS.Platform) => {
  const parts = devHomePathParts(candidate, platform);
  return parts !== undefined && comparableDevDbPath(parts.leaf, platform) === ".t3";
};

export const selectWorktreeDevHome = Effect.fn("selectWorktreeDevHome")(function* (
  candidate: string,
  worktreeHome: string | undefined,
) {
  if (worktreeHome === undefined) return undefined;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const comparable = (file: string) => comparableDevDbPath(file, platform);
  if (comparable(path.resolve(candidate)) === comparable(worktreeHome)) return worktreeHome;
  const split = devHomePathParts(candidate, platform);
  if (split === undefined || comparable(split.leaf) !== comparable(path.basename(worktreeHome))) {
    return undefined;
  }
  const parent = yield* resolveFilesystemPath(split.parent);
  const expected = yield* expectedDevHomePath(worktreeHome);
  return Option.exists(parent, (resolved) => resolved === path.dirname(expected))
    ? worktreeHome
    : undefined;
});

export const inspectIsolatedDevDirectory = Effect.fn("inspectIsolatedDevDirectory")(function* (
  baseDir: string,
  stateSubdir: "userdata" | "dev",
) {
  const path = yield* Path.Path;
  const base = yield* inspectPath(baseDir);
  const platform = yield* HostProcess.Platform;
  const parts = devHomePathParts(baseDir, platform);
  if (stateSubdir === "userdata" && parts && isDotT3Home(baseDir, platform)) {
    const parent = yield* inspectPath(parts.parent);
    if (base.canonical !== path.join(parent.canonical, parts.leaf)) {
      return yield* new MigrateDevDbSharedHomeError();
    }
  }
  const stateDir = path.join(base.canonical, stateSubdir);
  const state = yield* inspectPath(stateDir);
  if (state.canonical !== stateDir) return yield* new MigrateDevDbSharedHomeError();
  return { base, state };
});

export const assertIsolatedDevStartup = Effect.fn("assertIsolatedDevStartup")(function* (input: {
  readonly baseDir: string;
  readonly stateSubdir: "userdata" | "dev";
  readonly protectedHomes: readonly string[];
}) {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const { base, state } = yield* inspectIsolatedDevDirectory(input.baseDir, input.stateSubdir);
  const protectedPaths = yield* inspectProtectedHomes(
    input.protectedHomes,
    input.stateSubdir === "dev" ? base.canonical : undefined,
  );
  const files = stateDatabasePaths(state.canonical, path);
  yield* assertUnlinkedDatabaseFiles(files);
  const databasePaths = yield* Effect.forEach(files, inspectPath);
  const matches = (target: typeof base, candidates: readonly (typeof base)[]) =>
    candidates.some(
      (candidate) =>
        comparableDevDbPath(candidate.canonical, platform) ===
          comparableDevDbPath(target.canonical, platform) ||
        Option.exists(target.identity, (identity) => Option.contains(candidate.identity, identity)),
    );
  if (
    matches(state, protectedPaths.stateDirs) ||
    databasePaths.some((file) => matches(file, protectedPaths.databases)) ||
    (input.stateSubdir === "userdata" &&
      (matches(base, protectedPaths.homes) ||
        (yield* hasAnyMarker(base.canonical, STRICT_INSTALLED_MARKERS))))
  ) {
    return yield* new MigrateDevDbSharedHomeError();
  }
  return base.canonical;
});

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { ShellEnvironmentPatch } from "@t3tools/contracts";
import * as HostProcess from "./HostProcess.ts";
import * as Context from "effect/Context";
import { routineSpan } from "./observability.ts";
const POSIX_PATH_DELIMITER = ":";
const SHELL_ENV_NAME_PATTERN = /^[A-Z0-9_]+$/;
type ExecFileSyncLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: {
    encoding: "utf8";
    timeout: number;
    killSignal?: NodeJS.Signals | number;
    detached?: true;
    stdio?: ["ignore", "pipe", "ignore"];
  },
) => string;

function canExecuteFile(filePath: string): boolean {
  try {
    NodeFS.accessSync(filePath, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface CommandAvailabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly extendEnv?: boolean;
}

export interface ResolvedSpawnCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
}

export type SpawnExecutableResolver = (
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) => string | undefined | Promise<string | undefined>;

async function resolveSpawnExecutableWithNode(
  command: string,
  _platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const executable = async (candidate: string) => {
    try {
      if (!(await NodeFS.promises.stat(candidate)).isFile()) return false;
      await NodeFS.promises.access(candidate, NodeFS.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (command.includes("/")) return (await executable(command)) ? command : undefined;
  const pathValue = readEnvPath(env) ?? "";
  for (const entry of pathValue.split(":")) {
    if (entry === "" && pathValue === "") continue;
    // Preserve literal whitespace and quotes, and anchor the empty POSIX component.
    let candidate: string;
    try {
      candidate =
        entry === "" ? NodePath.posix.resolve(command) : NodePath.posix.join(entry, command);
    } catch {
      continue;
    }
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

export const SpawnExecutableResolution = Context.Reference<SpawnExecutableResolver>(
  "@t3tools/shared/shell/SpawnExecutableResolution",
  {
    defaultValue: () => resolveSpawnExecutableWithNode,
  },
);

function trimNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function readUserLoginShell(): string | undefined {
  try {
    return trimNonEmpty(NodeOS.userInfo().shell);
  } catch {
    return undefined;
  }
}

export function listLoginShellCandidates(
  platform: NodeJS.Platform,
  shell: string | undefined,
  userShell = readUserLoginShell(),
): ReadonlyArray<string> {
  const fallbackShell =
    platform === "darwin" ? "/bin/zsh" : platform === "linux" ? "/bin/bash" : undefined;
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const candidate of [trimNonEmpty(shell), trimNonEmpty(userShell), fallbackShell]) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    candidates.push(candidate);
  }

  return candidates;
}

export function readPathFromLaunchctl(
  execFile: ExecFileSyncLike = NodeChildProcess.execFileSync,
): string | undefined {
  try {
    return trimNonEmpty(
      execFile("/bin/launchctl", ["getenv", "PATH"], {
        encoding: "utf8",
        timeout: 2000,
      }),
    );
  } catch {
    return undefined;
  }
}

export function mergePathEntries(
  preferredPath: string | undefined,
  inheritedPath: string | undefined,
  _platform: NodeJS.Platform,
): string | undefined {
  const delimiter = ":";
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const pathValue of [preferredPath, inheritedPath]) {
    if (!pathValue) continue;
    for (const entry of pathValue.split(delimiter)) {
      if (!entry || seen.has(entry)) {
        continue;
      }
      seen.add(entry);
      merged.push(entry);
    }
  }

  return merged.length > 0 ? merged.join(delimiter) : undefined;
}

function envCaptureStart(name: string): string {
  return `__T3CODE_ENV_${name}_START__`;
}

function envCaptureEnd(name: string): string {
  return `__T3CODE_ENV_${name}_END__`;
}

const DEBUG_TRAP_SHELLS = new Set(["bash", "zsh", "sh", "ksh", "ksh93"]);
const POSIX_CAPTURE_SYNTAX = { assignment: "__T3CODE_PRINTENV=$(", orElse: " || " };
const PRINTENV_CAPTURE_SYNTAX = new Map(
  [...DEBUG_TRAP_SHELLS, "dash", "ash"].map((shell) => [shell, POSIX_CAPTURE_SYNTAX] as const),
).set("fish", { assignment: "set -l __T3CODE_PRINTENV (", orElse: "; or " });
// Network PATH entries must be probed inside the shell's deadline, away from the desktop thread.
const PRINTENV_LOOKUP_COMMAND = `/bin/sh -c 'command -v printenv || { [ -n "$1" ] && PATH="$1" command -v printenv; } || printf %s /usr/bin/printenv' t3`;

export function buildEnvironmentCaptureCommand(
  shell: string,
  names: ReadonlyArray<string>,
): string {
  const executableName = NodePath.basename(shell).toLowerCase();
  const isNushell = executableName.startsWith("nu");
  const syntax = PRINTENV_CAPTURE_SYNTAX.get(executableName);
  const supportsFallback = syntax !== undefined;
  const inheritedPath = resolvePathEnvironmentVariable(process.env)
    .split(POSIX_PATH_DELIMITER)
    .filter(Boolean)
    .map((entry) => NodePath.posix.resolve(entry))
    .join(POSIX_PATH_DELIMITER);
  const lookupPrintenv = `${PRINTENV_LOOKUP_COMMAND} '${inheritedPath.replaceAll("'", "'\\''")}'`;
  const { assignment, orElse } = syntax ?? POSIX_CAPTURE_SYNTAX;
  const resolvePrintenv = `${assignment}${lookupPrintenv}); `;

  const capture = names
    .map((name) => {
      if (!SHELL_ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`);
      }

      if (isNushell) {
        // Without a configured conversion, Nu expands home paths only in a list PATH.
        const defaultValue =
          name === "PATH"
            ? "if ($env.PATH? | describe | str starts-with 'list') { " +
              "$env.PATH | each {|p| if ($p | str starts-with '~') { " +
              "$p | path expand --no-symlink } else { $p } } | str join (char esep) " +
              "} else { $env.PATH? | default '' }"
            : `$env.${name}? | default ''`;
        const value =
          `if $env.${name}? == null { '' } else if ` +
          `$env.ENV_CONVERSIONS?.${name}?.to_string? != null { ` +
          `$env.${name} | do $env.ENV_CONVERSIONS.${name}.to_string $env.${name} ` +
          `} else { ${defaultValue} }`;
        return [
          `print '${envCaptureStart(name)}'`,
          `print (${value})`,
          `print '${envCaptureEnd(name)}'`,
        ].join("; ");
      }

      return [
        `printf '%s\\n' '${envCaptureStart(name)}'`,
        supportsFallback
          ? `printenv ${name}${orElse}"$__T3CODE_PRINTENV" ${name}${orElse}true`
          : `printenv ${name} || true`,
        `printf '%s\\n' '${envCaptureEnd(name)}'`,
      ].join("; ");
    })
    .join("; ");

  // A DEBUG trap that echoes each command (e.g. into the terminal title) would print the markers.
  // OpenBSD ksh (also its /bin/sh) exits on `trap - DEBUG`, so try it in a subshell first.
  const command = supportsFallback ? resolvePrintenv + capture : capture;
  return DEBUG_TRAP_SHELLS.has(executableName)
    ? `(trap - DEBUG) 2>/dev/null && trap - DEBUG; ${command}`
    : command;
}

function extractEnvironmentValue(output: string, name: string): string | undefined {
  const startMarker = envCaptureStart(name);
  const endMarker = envCaptureEnd(name);
  const startIndex = output.indexOf(startMarker);
  if (startIndex === -1) return undefined;

  const valueStartIndex = startIndex + startMarker.length;
  const endIndex = output.indexOf(endMarker, valueStartIndex);
  if (endIndex === -1) return undefined;

  const value = output
    .slice(valueStartIndex, endIndex)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");

  return value.length > 0 ? value : undefined;
}

/** Reads the values `buildEnvironmentCaptureCommand` printed; unset or empty names are omitted. */
export function extractEnvironmentValues(
  output: string,
  names: ReadonlyArray<string>,
): Partial<Record<string, string>> {
  const environment: Partial<Record<string, string>> = {};
  for (const name of names) {
    const value = extractEnvironmentValue(output, name);
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

export type ShellEnvironmentReader = (
  shell: string,
  names: ReadonlyArray<string>,
  execFile?: ExecFileSyncLike,
) => Partial<Record<string, string>>;

export const readEnvironmentFromLoginShell: ShellEnvironmentReader = (
  shell,
  names,
  execFile = NodeChildProcess.execFileSync,
) => {
  if (names.length === 0) {
    return {};
  }

  // Interactive startup loads PATH entries; detaching prevents job control on an
  // inherited controlling TTY from stopping the probe while the parent waits.
  const output = execFile(shell, ["-ilc", buildEnvironmentCaptureCommand(shell, names)], {
    encoding: "utf8",
    timeout: 5000,
    killSignal: "SIGKILL",
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });

  return extractEnvironmentValues(output, names);
};

function readEnvPath(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH;
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return readEnvPath(env) ?? "";
}

// Explicit paths bypass the cache for new installs; cached misses can otherwise hide binaries for 30 seconds.
const COMMAND_RESOLUTION_CACHE_TTL_NANOS = 30_000_000_000n;
const COMMAND_RESOLUTION_CACHE_MAX_ENTRIES = 512;
const COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR = String.fromCharCode(0);

interface CommandResolutionCacheEntry {
  readonly resolvedPath: string | null;
  readonly expiresAtNanos: bigint;
}

export const CommandResolutionCache = Context.Reference<Map<string, CommandResolutionCacheEntry>>(
  "@t3tools/shared/shell/CommandResolutionCache",
  {
    defaultValue: () => new Map(),
  },
);

// Resolver-specific cache entries are kept apart even when their test and live inputs match.
let spawnResolverCacheIdCount = 0;
const spawnResolverCacheIds = new WeakMap<SpawnExecutableResolver | XcodeGitLocator, number>();
function spawnResolverCacheId(resolver: SpawnExecutableResolver | XcodeGitLocator): number {
  const known = spawnResolverCacheIds.get(resolver);
  if (known !== undefined) return known;
  const id = spawnResolverCacheIdCount++;
  spawnResolverCacheIds.set(resolver, id);
  return id;
}

function cacheCommandResolution(
  cache: Map<string, CommandResolutionCacheEntry>,
  cacheKey: string,
  resolvedPath: string | null,
  nowNanos: bigint,
): void {
  if (cache.size >= COMMAND_RESOLUTION_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(cacheKey, {
    resolvedPath,
    expiresAtNanos: nowNanos + COMMAND_RESOLUTION_CACHE_TTL_NANOS,
  });
}

const isExecutableFile = Effect.fnUntraced(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const stat = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
  return stat !== null && stat.type === "File" && canExecuteFile(filePath);
});

function pathEntries(pathValue: string): string[] {
  if (!pathValue) return [];
  return [...new Set(pathValue.split(":").map((entry) => entry || "."))];
}

// Relative POSIX PATH entries resolve against the cwd, so caches keyed by them include it.
// null means a relative entry is present but the cwd cannot be read, so nothing is cached.
function pathSearchCwd(pathValue: string): string | null | undefined {
  if (pathEntries(pathValue).every((entry) => NodePath.posix.isAbsolute(entry))) return undefined;
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

const findOnPath = Effect.fnUntraced(function* (
  pathValue: string,
  command: string,
  isLast: (match: string) => boolean,
  cwd: string | null | undefined,
) {
  const path = yield* Path.Path;
  // A literal "." keeps its relative spelling. Its first occurrence and an empty entry
  // compete in PATH order; a match through an empty entry is anchored before spawning.
  const anchorsCwd =
    typeof cwd === "string" &&
    pathValue.split(":").find((entry) => entry === "" || entry === ".") === "";
  const matches: string[] = [];
  for (const dir of pathEntries(pathValue)) {
    const match = path.join(anchorsCwd && dir === "." ? cwd : dir, command);
    if (yield* isExecutableFile(match)) {
      matches.push(match);
      if (isLast(match)) break;
    }
  }
  return matches;
});

export const resolveCommandPath = Effect.fn("shell.resolveCommandPath", {
  attributes: routineSpan,
})(function* (command: string, options: CommandAvailabilityOptions = {}) {
  if (command.includes("/")) return (yield* isExecutableFile(command)) ? command : null;
  const pathValue = resolvePathEnvironmentVariable(options.env ?? (yield* HostProcess.Environment));
  if (!pathValue) return null;
  const cwd = pathSearchCwd(pathValue);
  const cacheKey = [pathValue, command, ...(cwd === undefined ? [] : [cwd])].join(
    COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR,
  );
  const cache = yield* CommandResolutionCache;
  const nowNanos = yield* Clock.monotonicTimeNanos;
  const cached = cwd === null ? undefined : cache.get(cacheKey);
  if (cached !== undefined && cached.expiresAtNanos > nowNanos) return cached.resolvedPath;
  const [resolved = null] = yield* findOnPath(pathValue, command, () => true, cwd);
  if (cwd !== null) cacheCommandResolution(cache, cacheKey, resolved, nowNanos);
  return resolved;
});

// Matches for a bare command in PATH order, up to the first one `until` accepts; not cached.
export const resolveCommandPaths = Effect.fn("shell.resolveCommandPaths", {
  attributes: routineSpan,
})(function* (
  command: string,
  options: CommandAvailabilityOptions & { readonly until: (match: string) => boolean },
) {
  const pathValue = resolvePathEnvironmentVariable(options.env ?? (yield* HostProcess.Environment));
  return yield* findOnPath(pathValue, command, options.until, pathSearchCwd(pathValue));
});

export type XcodeGitLocator = (env: NodeJS.ProcessEnv) => string | undefined;

// xcrun honors DEVELOPER_DIR and the `xcode-select` choice, as the shim does.
function locateXcodeGitWithXcrun(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const located = NodeChildProcess.execFileSync("/usr/bin/xcrun", ["--find", "git"], {
      encoding: "utf8",
      env,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return NodePath.isAbsolute(located) ? located : undefined;
  } catch {
    return undefined;
  }
}

export const XcodeGitLocation = Context.Reference<XcodeGitLocator>(
  "@t3tools/shared/shell/XcodeGitLocation",
  { defaultValue: () => locateXcodeGitWithXcrun },
);

const MACOS_GIT_SHIM = "/usr/bin/git";

/**
 * Skip the xcrun shim's per-spawn lookup only when git resolves to /usr/bin/git.
 * User-selected git on PATH still wins, children keep PATH, and lookup failures use `git`.
 */
const resolveMacosGit = Effect.fnUntraced(function* (
  env: NodeJS.ProcessEnv,
  resolveExecutable: SpawnExecutableResolver,
) {
  const locateXcodeGit = yield* XcodeGitLocation;
  const cache = yield* CommandResolutionCache;
  const pathValue = resolvePathEnvironmentVariable(env);
  const nowNanos = yield* Clock.currentTimeNanos;
  // Read after the clock, so the lookup below starts in the directory the key names.
  const cwd = pathSearchCwd(pathValue);
  const cacheKey = [
    "xcode-git",
    String(spawnResolverCacheId(resolveExecutable)),
    String(spawnResolverCacheId(locateXcodeGit)),
    pathValue,
    env.DEVELOPER_DIR ?? "",
    ...(cwd === undefined ? [] : [cwd]),
  ].join(COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR);
  const cached = cwd === null ? undefined : cache.get(cacheKey);
  // An Xcode update or removal deletes the binary; look again instead of failing the spawn.
  if (cached !== undefined && cached.expiresAtNanos > nowNanos) {
    const cachedPath = cached.resolvedPath;
    if (
      cachedPath === null ||
      (yield* Effect.promise(async () => resolveExecutable(cachedPath, "darwin", env))) !==
        undefined
    ) {
      return cachedPath ?? "git";
    }
  }
  const pathGit = yield* Effect.promise(async () => resolveExecutable("git", "darwin", env));
  const located = pathGit === MACOS_GIT_SHIM ? locateXcodeGit(env) : undefined;
  const realGit =
    located !== undefined &&
    (yield* Effect.promise(async () => resolveExecutable(located, "darwin", env))) !== undefined
      ? located
      : // A match anchored to the cwd came through an empty PATH entry, which a child would search
        // again from its own cwd; launch the file that was checked instead of bare `git`.
        typeof cwd === "string" && pathGit === NodePath.posix.join(cwd, "git")
        ? pathGit
        : null;
  // The lookups above await and the cwd can move meanwhile; cache only what the key's cwd found.
  if (cwd !== null && pathSearchCwd(pathValue) === cwd) {
    cacheCommandResolution(cache, cacheKey, realGit, nowNanos);
  }
  return realGit ?? "git";
});

export const resolveSpawnCommand = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: CommandAvailabilityOptions = {},
): Effect.fn.Return<ResolvedSpawnCommand> {
  const platform = yield* HostProcess.Platform;
  const isMacosGit = platform === "darwin" && command === "git";
  if (!isMacosGit) {
    return { command, args: [...args], shell: false };
  }

  const hostEnvironment = yield* HostProcess.Environment;
  const env =
    options.env === undefined
      ? hostEnvironment
      : options.extendEnv
        ? { ...hostEnvironment, ...options.env }
        : options.env;
  const resolveExecutable = yield* SpawnExecutableResolution;
  return {
    command: yield* resolveMacosGit(env, resolveExecutable),
    args: [...args],
    shell: false,
  };
});

export const isCommandAvailable = Effect.fn("shell.isCommandAvailable")(function* (
  command: string,
  options: CommandAvailabilityOptions = {},
) {
  return (yield* resolveCommandPath(command, options)) !== null;
});

export function applyShellEnvironment(
  env: NodeJS.ProcessEnv,
  patch: ShellEnvironmentPatch,
  _platform: NodeJS.Platform,
): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
}

interface PathSetupInput {
  readonly directory: string;
  readonly home: string;
  readonly shell: string | undefined;
  readonly platform: NodeJS.Platform;
  /** `XDG_CONFIG_HOME`, where fish reads its startup file when set. */
  readonly configHome?: string | undefined;
  /** `ZDOTDIR`, where zsh reads `.zshrc` when set. */
  readonly zdotdir?: string | undefined;
}

/**
 * The startup file (`~/...`, or absolute under `configHome`) and line that put `directory` last on
 * PATH for new zsh, bash, or fish terminals, so it never shadows another `t3`. Unsupported
 * platforms, other shells, macOS bash, or unsafe paths do not get a setup command.
 */
export function pathSetup(
  input: PathSetupInput,
): { readonly file: string; readonly line: string } | undefined {
  // A relative folder on PATH would follow the working directory into any checkout.
  if (
    (input.platform !== "darwin" && input.platform !== "linux") ||
    !input.directory.startsWith("/")
  )
    return undefined;
  const underHome = input.directory.startsWith(`${input.home}/`);
  const rest = underHome ? input.directory.slice(input.home.length) : input.directory;
  if (!/^[\w./-]+$/.test(rest)) return undefined;
  const directory = underHome ? `$HOME${rest}` : rest;
  const shell = input.shell?.split("/").pop();
  // A set folder the shell reads from replaces the default; one unsafe to write means no setup,
  // since the default file would never be read.
  const readFrom = (value: string | undefined, fallback: string) =>
    !value ? fallback : value.startsWith("/") && /^[\w./-]+$/.test(value) ? value : undefined;
  if (shell === "fish") {
    const configHome = readFrom(input.configHome, "~/.config");
    if (configHome === undefined) return undefined;
    // --path changes $PATH itself; fish_user_paths would go ahead of the system folders.
    return {
      file: `${configHome}/fish/config.fish`,
      line: `fish_add_path --append --path ${directory}`,
    };
  }
  // macOS bash reads only the first of .bash_profile, .bash_login, and .profile; no file is safe.
  const zdotdir = readFrom(input.zdotdir, "~");
  const file =
    shell === "zsh"
      ? zdotdir && `${zdotdir}/.zshrc`
      : shell === "bash" && input.platform !== "darwin"
        ? "~/.bashrc"
        : undefined;
  return file === undefined ? undefined : { file, line: `export PATH="$PATH:${directory}"` };
}

/** A command to paste that does what {@link pathSetup} describes. */
export function pathSetupCommand(input: PathSetupInput): string | undefined {
  const setup = pathSetup(input);
  if (!setup) return undefined;
  // The leading newline keeps the line out of a final comment with no newline after it.
  const append = `printf '\\n%s\\n' '${setup.line}' >> ${setup.file}`;
  // fish's config folder may not exist yet; `&&` works in fish 3 too.
  return setup.file.endsWith(".fish")
    ? `mkdir -p ${setup.file.slice(0, setup.file.lastIndexOf("/"))} && ${append}`
    : append;
}

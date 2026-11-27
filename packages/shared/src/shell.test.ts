// @effect-diagnostics nodeBuiltinImport:off -- The synchronous shell probe runs real commands with isolated config files.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { DesktopHostTelemetryMessage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  applyShellEnvironment,
  pathSetup,
  pathSetupCommand,
  CommandResolutionCache,
  listLoginShellCandidates,
  mergePathEntries,
  readEnvironmentFromLoginShell,
  resolveCommandPath,
  resolveSpawnCommand,
  SpawnExecutableResolution,
  XcodeGitLocation,
} from "./shell.ts";

const decodeDesktopHostMessage = Schema.decodeUnknownSync(DesktopHostTelemetryMessage);

describe("readEnvironmentFromLoginShell", () => {
  // Opt in with an explicit binary, like the provider live probes; CI need not install Nu.
  it.runIf(process.env.T3_TEST_NU_PATH !== undefined)(
    "captures Nushell PATH and multiline values without external tools",
    () => {
      const shell = process.env.T3_TEST_NU_PATH!;
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-nu-env-"));
      try {
        const toolPath = NodePath.join(home, "nu tools", "bin");
        const extraToolPath = NodePath.join(home, "extra-tools", "bin");
        NodeFS.mkdirSync(toolPath, { recursive: true });
        NodeFS.mkdirSync(extraToolPath, { recursive: true });
        const config = NodePath.join(home, "config.nu");
        const envConfig = NodePath.join(home, "env.nu");
        NodeFS.writeFileSync(envConfig, "");
        NodeFS.writeFileSync(
          config,
          [
            `$env.PATH = [${JSON.stringify(toolPath)}, "~/extra-tools/bin", "rel/dir", ""]`,
            '$env.CUSTOM_VAR = "  first\\nsecond  "',
            '$env.EMPTY_VAR = ""',
            'print "startup noise"',
          ].join("\n"),
        );

        expect(
          readEnvironmentFromLoginShell(
            shell,
            ["MISSING_VAR", "PATH", "EMPTY_VAR", "CUSTOM_VAR"],
            (file, args, options) =>
              NodeChildProcess.execFileSync(
                file,
                ["--no-history", "--config", config, "--env-config", envConfig, ...args],
                {
                  ...options,
                  env: { HOME: home, XDG_CONFIG_HOME: home, PATH: toolPath },
                },
              ),
          ),
        ).toEqual({
          PATH: `${toolPath}:${extraToolPath}:rel/dir:`,
          CUSTOM_VAR: "  first\nsecond  ",
        });
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.runIf(NodeFS.existsSync("/bin/bash"))(
    "captures values when the profile replaces PATH and a DEBUG trap echoes commands",
    () => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bash-env-"));
      try {
        const tools = NodePath.join(home, "tools 'quoted $dir");
        NodeFS.mkdirSync(tools);
        const printenv = NodeChildProcess.execFileSync("/bin/bash", ["-c", "type -P printenv"], {
          encoding: "utf8",
          env: { PATH: process.env.PATH },
        }).trim();
        // macOS kills copied system executables outside their signed location.
        NodeFS.symlinkSync(printenv, NodePath.join(tools, "printenv"));
        vi.stubEnv("PATH", tools);
        const shellPath = NodePath.join(home, "bin");
        const bashEnv = NodePath.join(home, "env.bash");
        NodeFS.writeFileSync(
          bashEnv,
          [
            `export PATH='${shellPath.replaceAll("'", "'\\''")}'`,
            // Simulate a non-FHS host while retaining the real executable in its private prefix.
            "function /usr/bin/printenv { return 127; }",
            `trap 'echo -ne "\\033]0;\${BASH_COMMAND}\\007"' DEBUG`,
          ].join("\n"),
        );

        expect(
          readEnvironmentFromLoginShell(
            "/bin/bash",
            ["XDG_DATA_HOME", "PATH"],
            // Non-interactive bash reads only BASH_ENV, not the host's /etc startup files that -il runs.
            (file, [, command = ""], options) =>
              NodeChildProcess.execFileSync(file, ["-c", command], {
                ...options,
                env: { HOME: home, PATH: tools, TERM: "dumb", BASH_ENV: bashEnv },
              }),
          ),
        ).toEqual({ PATH: shellPath });
      } finally {
        vi.unstubAllEnvs();
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("extracts multiple environment variables from a login shell command", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__T3CODE_ENV_PATH_START__",
        "/a:/b",
        "__T3CODE_ENV_PATH_END__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_START__",
        "/tmp/secretive.sock",
        "__T3CODE_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith("/bin/zsh", expect.any(Array), {
      encoding: "utf8",
      timeout: 5000,
      killSignal: "SIGKILL",
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  });

  it("omits environment variables that are missing or empty", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__T3CODE_ENV_PATH_START__",
        "/a:/b",
        "__T3CODE_ENV_PATH_END__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_START__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
    });
  });

  it("preserves multiline values and surrounding whitespace", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__T3CODE_ENV_CUSTOM_VAR_START__",
        "  first\nsecond  ",
        "__T3CODE_ENV_CUSTOM_VAR_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["CUSTOM_VAR"], execFile)).toEqual({
      CUSTOM_VAR: "  first\nsecond  ",
    });
  });
});

describe("listLoginShellCandidates", () => {
  it("returns env shell, user shell, then the platform fallback without duplicates", () => {
    expect(listLoginShellCandidates("darwin", " /opt/homebrew/bin/nu ", "/bin/zsh")).toEqual([
      "/opt/homebrew/bin/nu",
      "/bin/zsh",
    ]);
  });
});

describe("mergePathEntries", () => {
  it("prefers login-shell PATH entries and keeps inherited extras", () => {
    expect(
      mergePathEntries("/opt/homebrew/bin:/usr/bin", "/Users/test/.local/bin:/usr/bin", "darwin"),
    ).toBe("/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
    expect(mergePathEntries("/opt/bin :/opt/bin", "/opt/bin :/usr/bin", "linux")).toBe(
      "/opt/bin :/opt/bin:/usr/bin",
    );
  });
});

describe("mergePathEntries", () => {
  it("dedupes case-sensitively on POSIX", () => {
    expect(mergePathEntries("/usr/local/bin:/usr/bin", "/usr/bin:/USR/BIN", "linux")).toBe(
      "/usr/local/bin:/usr/bin:/USR/BIN",
    );
    expect(mergePathEntries("/opt/bin :/opt/bin", "/opt/bin :/usr/bin", "linux")).toBe(
      "/opt/bin :/opt/bin:/usr/bin",
    );
    expect(mergePathEntries('/opt/bin"', "/opt/bin", "linux")).toBe('/opt/bin":/opt/bin');
  });
});

effectIt.layer(NodeServices.layer)("resolveCommandPath", (it) => {
  it.effect("finds executables in a POSIX PATH directory ending in whitespace and quotes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ directory: ".", prefix: "t3-path-" });
      const directory = `${cwd}/bin \u00a0"`;
      yield* fs.makeDirectory(directory);
      const executable = `${directory}/audit-command`;
      yield* fs.writeFileString(executable, "#!/bin/sh\n");
      yield* fs.chmod(executable, 0o755);
      const env = { PATH: directory };

      expect(
        yield* resolveCommandPath("audit-command", { env }).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(CommandResolutionCache, new Map()),
        ),
      ).toBe(path.join(directory, "audit-command"));
      const resolveExecutable = yield* SpawnExecutableResolution;
      expect(
        yield* Effect.promise(async () => resolveExecutable("audit-command", "linux", env)),
      ).toBe(executable);
    }),
  );

  // Candidates are checked against the process cwd, so the lookup runs in a child with a temp cwd.
  const resolveInChild = `
import { createRequire } from "node:module";
const [shellPath, command, rawPaths, rawGitPaths, gitShim, xcodeGit] = process.argv.slice(1);
const requireFromShell = createRequire(shellPath);
const Effect = await import(requireFromShell.resolve("effect/Effect"));
const { layer } = await import(requireFromShell.resolve("@effect/platform-node/NodeServices"));
const HostProcess = await import(shellPath.replace(/shell\\.ts$/, "HostProcess.ts"));
const Shell = await import(shellPath);
const resolved = {};
const resolvedGit = {};
const defaultResolver = Shell.SpawnExecutableResolution.defaultValue();
const resolveExecutable = async (...args) => {
  const found = await defaultResolver(...args);
  return found === gitShim ? "/usr/bin/git" : found;
};
const locateXcodeGit = () => xcodeGit;
await Effect.runPromise(Effect.gen(function* () {
  const caches = new Map();
  for (const [label, { PATH, cwd, cacheGroup }] of Object.entries(JSON.parse(rawPaths))) {
    process.chdir(cwd);
    let cache = caches.get(cacheGroup);
    if (!cache) caches.set(cacheGroup, cache = new Map());
    resolved[label] = {
      effect: yield* Shell.resolveCommandPath(command, { env: { PATH } }).pipe(
        Effect.provideService(HostProcess.Platform, process.platform),
        Effect.provideService(Shell.CommandResolutionCache, cache),
      ),
      spawn: (yield* Effect.promise(async () => Shell.SpawnExecutableResolution.defaultValue()(command, process.platform, { PATH }))) ?? null,
    };
  }
  for (const [label, { PATH, cwd, cacheGroup }] of Object.entries(JSON.parse(rawGitPaths))) {
    process.chdir(cwd);
    let cache = caches.get(cacheGroup);
    if (!cache) caches.set(cacheGroup, cache = new Map());
    resolvedGit[label] = yield* Shell.resolveSpawnCommand("git", ["status"], { env: { PATH } }).pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(Shell.SpawnExecutableResolution, resolveExecutable),
      Effect.provideService(Shell.XcodeGitLocation, locateXcodeGit),
      Effect.provideService(Shell.CommandResolutionCache, cache),
    );
  }
}).pipe(Effect.provide(layer)));
console.log(JSON.stringify({ resolved, resolvedGit }));
`;

  it.effect(
    "searches the current directory for empty POSIX PATH components across cached lookups",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Real paths: the child's process.cwd() reports them, and anchored matches start with it.
        const cwd = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-empty-path-cwd-" }),
        );
        const listed = yield* fs.makeTempDirectoryScoped({ prefix: "t3-empty-path-listed-" });
        const empty = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-empty-path-absent-" }),
        );
        const command = "t3-empty-path-cli";
        const inCwd = path.join(cwd, command);
        const inListed = path.join(listed, command);
        const gitShim = path.join(listed, "git");
        const xcodeGit = path.join(listed, "xcode-git");
        yield* fs.writeFileString(inCwd, "#!/bin/sh\n", { mode: 0o755 });
        yield* fs.writeFileString(inListed, "#!/bin/sh\n", { mode: 0o755 });
        yield* fs.writeFileString(path.join(cwd, "git"), "#!/bin/sh\n", { mode: 0o755 });
        yield* fs.writeFileString(gitShim, "#!/bin/sh\n", { mode: 0o755 });
        yield* fs.writeFileString(xcodeGit, "#!/bin/sh\n", { mode: 0o755 });
        yield* fs.utimes(cwd, 4_102_444_800, 4_102_444_800);
        yield* fs.utimes(empty, 4_102_444_800, 4_102_444_800);
        const missing = path.join(cwd, "missing");

        const searches = {
          dot: { PATH: ".", expected: inCwd },
          leading: { PATH: `:${missing}`, expected: inCwd },
          trailing: { PATH: `${missing}:`, expected: inCwd },
          interior: { PATH: `${missing}::${missing}-2`, expected: inCwd },
          leadingBeforeListed: { PATH: `:${listed}`, expected: inCwd },
          listedBeforeTrailing: { PATH: `${listed}:`, expected: inListed },
          dotBeforeEmpty: { PATH: `.:${missing}:`, expected: inCwd },
          emptyBeforeDot: { PATH: `:.:${missing}`, expected: inCwd },
          entirelyEmpty: { PATH: "", expected: null },
          whitespaceOnly: { PATH: `${missing}: `, expected: null },
        };

        const cachedSearches = {
          cachedMiss: { PATH: `:${missing}`, cwd: empty, cacheGroup: "miss", expected: null },
          afterMiss: { PATH: `:${missing}`, cwd, cacheGroup: "miss", expected: inCwd },
          cachedHit: { PATH: `:${missing}`, cwd, cacheGroup: "hit", expected: inCwd },
          afterHit: { PATH: `:${missing}`, cwd: empty, cacheGroup: "hit", expected: null },
          cachedListed: {
            PATH: `:${listed}`,
            cwd: empty,
            cacheGroup: "listed",
            expected: inListed,
          },
          beforeListed: { PATH: `:${listed}`, cwd, cacheGroup: "listed", expected: inCwd },
          cachedLocal: { PATH: `:${listed}`, cwd, cacheGroup: "local", expected: inCwd },
          afterLocal: { PATH: `:${listed}`, cwd: empty, cacheGroup: "local", expected: inListed },
        };
        const entries = [
          ...Object.entries(cachedSearches),
          ...Object.entries(searches).map(
            ([label, row]) => [label, { ...row, cwd, cacheGroup: label }] as const,
          ),
        ];
        const gitEntries = ["", "."].flatMap((entry) => {
          const PATH = `${entry}:${listed}`;
          // An empty entry launches the local git it found; "." keeps its relative spelling.
          const localGit = entry === "" ? path.join(cwd, "git") : "git";
          return [
            { PATH, cwd: empty, cacheGroup: `xcode-first-${entry}`, expected: xcodeGit },
            { PATH, cwd, cacheGroup: `xcode-first-${entry}`, expected: localGit },
            { PATH, cwd, cacheGroup: `local-first-${entry}`, expected: localGit },
            { PATH, cwd: empty, cacheGroup: `local-first-${entry}`, expected: xcodeGit },
          ];
        });
        // A match from an absolute entry stays bare `git`, even when PATH also has a relative entry.
        gitEntries.push({ PATH: `.:${cwd}`, cwd: empty, cacheGroup: "absolute", expected: "git" });
        const stdout = NodeChildProcess.execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            resolveInChild,
            path.join(import.meta.dirname, "shell.ts"),
            command,
            JSON.stringify(
              Object.fromEntries(
                entries.map(([label, row]) => [
                  label,
                  {
                    PATH: row.PATH,
                    cwd: row.cwd,
                    cacheGroup: row.cacheGroup,
                  },
                ]),
              ),
            ),
            JSON.stringify(gitEntries),
            gitShim,
            xcodeGit,
          ],
          { cwd, encoding: "utf8", env: {} },
        );
        const {
          resolved,
          resolvedGit,
        }: {
          resolved: Record<string, { effect: string | null; spawn: string | null }>;
          resolvedGit: Record<string, { command: string; args: string[]; shell: boolean }>;
        } = JSON.parse(stdout);

        // A relative result is relative to the child's cwd.
        const anchored = (found: string | null, directory: string) =>
          found === null ? null : path.resolve(directory, found);
        const directories = Object.fromEntries(entries.map(([label, row]) => [label, row.cwd]));
        expect(
          Object.fromEntries(
            Object.entries(resolved).map(([label, found]) => {
              const directory = directories[label];
              if (directory === undefined) throw new Error(`Unexpected resolver case: ${label}`);
              return [
                label,
                {
                  effect: anchored(found.effect, directory),
                  spawn: anchored(found.spawn, directory),
                },
              ];
            }),
          ),
        ).toEqual(
          Object.fromEntries(
            entries.map(([label, row]) => [label, { effect: row.expected, spawn: row.expected }]),
          ),
        );
        // A match through an empty component comes back absolute, so callers can launch it from
        // another cwd or through a wrapper; a literal "." keeps main's relative spelling.
        for (const label of [
          "leading",
          "trailing",
          "interior",
          "leadingBeforeListed",
          "afterMiss",
          "cachedHit",
          "beforeListed",
          "cachedLocal",
          "emptyBeforeDot",
        ]) {
          expect(resolved[label], label).toEqual({ effect: inCwd, spawn: inCwd });
        }
        for (const label of ["dot", "dotBeforeEmpty"]) {
          expect(resolved[label], label).toEqual({ effect: command, spawn: command });
        }
        expect(resolvedGit).toEqual(
          Object.fromEntries(
            gitEntries.map((row, index) => [
              String(index),
              { command: row.expected, args: ["status"], shell: false },
            ]),
          ),
        );
      }),
  );

  // Deleting the working directory makes process.cwd() throw, so this also runs in a child.
  const resolveWithoutCwd = `
import { createRequire } from "node:module";
import * as NodeFS from "node:fs";
const [shellPath, command, PATH, removed, gitShim, xcodeGit] = process.argv.slice(1);
const requireFromShell = createRequire(shellPath);
const Effect = await import(requireFromShell.resolve("effect/Effect"));
const { layer } = await import(requireFromShell.resolve("@effect/platform-node/NodeServices"));
const HostProcess = await import(shellPath.replace(/shell\\.ts$/, "HostProcess.ts"));
const Shell = await import(shellPath);
const defaultResolver = Shell.SpawnExecutableResolution.defaultValue();
const resolveExecutable = async (...args) => {
  const found = await defaultResolver(...args);
  return found === gitShim ? "/usr/bin/git" : found;
};
process.chdir(removed);
NodeFS.rmdirSync(removed);
const cache = new Map();
const result = await Effect.runPromise(Effect.gen(function* () {
  const effect = yield* Shell.resolveCommandPath(command, { env: { PATH } }).pipe(
    Effect.provideService(HostProcess.Platform, process.platform),
  );
  const git = yield* Shell.resolveSpawnCommand("git", ["status"], { env: { PATH } }).pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(Shell.SpawnExecutableResolution, resolveExecutable),
    Effect.provideService(Shell.XcodeGitLocation, () => xcodeGit),
  );
  return { effect, git: git.command };
}).pipe(
  Effect.provideService(Shell.CommandResolutionCache, cache),
  Effect.provide(layer),
));
console.log(JSON.stringify({ ...result, cached: cache.size }));
`;

  it.effect(
    "searches absolute PATH entries and caches nothing when the working directory is gone",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const listed = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gone-cwd-listed-" });
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gone-cwd-parent-" });
        const removed = path.join(parent, "removed");
        yield* fs.makeDirectory(removed);
        const command = "t3-gone-cwd-cli";
        const inListed = path.join(listed, command);
        const gitShim = path.join(listed, "git");
        const xcodeGit = path.join(listed, "xcode-git");
        yield* fs.writeFileString(inListed, "#!/bin/sh\n", { mode: 0o755 });
        yield* fs.writeFileString(gitShim, "#!/bin/sh\n", { mode: 0o755 });
        yield* fs.writeFileString(xcodeGit, "#!/bin/sh\n", { mode: 0o755 });

        const stdout = NodeChildProcess.execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            resolveWithoutCwd,
            path.join(import.meta.dirname, "shell.ts"),
            command,
            `:${listed}`,
            removed,
            gitShim,
            xcodeGit,
          ],
          { cwd: parent, encoding: "utf8", env: {} },
        );

        expect(JSON.parse(stdout)).toEqual({ effect: inListed, git: xcodeGit, cached: 0 });
      }),
  );

  // Node caches process.cwd(), so after a rename it names a path that no longer exists.
  const resolveAfterRename = `
import { createRequire } from "node:module";
import * as NodeFS from "node:fs";
const [shellPath, command, cwd, renamed] = process.argv.slice(1);
const requireFromShell = createRequire(shellPath);
const Effect = await import(requireFromShell.resolve("effect/Effect"));
const { layer } = await import(requireFromShell.resolve("@effect/platform-node/NodeServices"));
const HostProcess = await import(shellPath.replace(/shell\\.ts$/, "HostProcess.ts"));
const Shell = await import(shellPath);
process.chdir(cwd);
process.cwd();
NodeFS.renameSync(cwd, renamed);
const resolved = await Effect.runPromise(
  Shell.resolveCommandPath(command, { env: { PATH: "bin" } }).pipe(
    Effect.provideService(HostProcess.Platform, process.platform),
    Effect.provideService(Shell.CommandResolutionCache, new Map()),
    Effect.provide(layer),
  ),
);
console.log(JSON.stringify(resolved));
`;

  it.effect("resolves a relative PATH entry after the working directory is renamed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-renamed-cwd-" });
      const cwd = path.join(parent, "before");
      const command = "t3-renamed-cwd-cli";
      yield* fs.makeDirectory(path.join(cwd, "bin"), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, "bin", command), "#!/bin/sh\n", { mode: 0o755 });

      const stdout = NodeChildProcess.execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          resolveAfterRename,
          path.join(import.meta.dirname, "shell.ts"),
          command,
          cwd,
          path.join(parent, "after"),
        ],
        { cwd: parent, encoding: "utf8", env: {} },
      );

      expect(JSON.parse(stdout)).toBe(path.join("bin", command));
    }),
  );
});

effectIt.layer(NodeServices.layer)("resolveSpawnCommand", (it) => {
  describe("macOS git", () => {
    // Files that exist, the git first on PATH, and what `xcrun --find git` prints.
    const setup = (options: {
      readonly platform?: NodeJS.Platform;
      readonly gitOnPath: string;
      readonly xcrunGit: string | undefined;
    }) => {
      const files = new Set([options.gitOnPath, ...(options.xcrunGit ? [options.xcrunGit] : [])]);
      const host = { xcrunGit: options.xcrunGit, xcrunCalls: 0 };
      const resolve = resolveSpawnCommand("git", ["status"], { env: { PATH: "/fake/bin" } }).pipe(
        Effect.map((resolved) => resolved.command),
        Effect.provideService(HostProcess.Platform, options.platform ?? "darwin"),
        Effect.provideService(SpawnExecutableResolution, (command) =>
          command === "git" ? options.gitOnPath : files.has(command) ? command : undefined,
        ),
        Effect.provideService(XcodeGitLocation, () => {
          host.xcrunCalls += 1;
          return host.xcrunGit;
        }),
      );
      return { files, host, resolve };
    };

    const XCODE_GIT = "/Applications/Xcode.app/Contents/Developer/usr/bin/git";

    it.effect("runs the git behind the xcrun shim and looks it up once", () =>
      Effect.gen(function* () {
        const { host, resolve } = setup({ gitOnPath: "/usr/bin/git", xcrunGit: XCODE_GIT });
        expect(yield* resolve).toBe(XCODE_GIT);
        expect(yield* resolve).toBe(XCODE_GIT);
        expect(host.xcrunCalls).toBe(1);
      }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
    );

    it.effect("keeps git when PATH has another git or the host is not macOS", () =>
      Effect.gen(function* () {
        const homebrew = setup({ gitOnPath: "/opt/homebrew/bin/git", xcrunGit: XCODE_GIT });
        expect(yield* homebrew.resolve).toBe("git");
        expect(homebrew.host.xcrunCalls).toBe(0);

        const linux = setup({ platform: "linux", gitOnPath: "/usr/bin/git", xcrunGit: XCODE_GIT });
        expect(yield* linux.resolve).toBe("git");
      }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
    );

    it.effect("keeps git when xcrun fails or names a missing file", () =>
      Effect.gen(function* () {
        const failed = setup({ gitOnPath: "/usr/bin/git", xcrunGit: undefined });
        expect(yield* failed.resolve).toBe("git");

        const missing = setup({ gitOnPath: "/usr/bin/git", xcrunGit: XCODE_GIT });
        missing.files.delete(XCODE_GIT);
        expect(yield* missing.resolve).toBe("git");
      }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
    );

    it.effect("looks again when the resolved git disappears", () =>
      Effect.gen(function* () {
        const betaGit = "/Applications/Xcode-beta.app/Contents/Developer/usr/bin/git";
        const { files, host, resolve } = setup({ gitOnPath: "/usr/bin/git", xcrunGit: XCODE_GIT });
        expect(yield* resolve).toBe(XCODE_GIT);

        files.delete(XCODE_GIT);
        files.add(betaGit);
        host.xcrunGit = betaGit;
        expect(yield* resolve).toBe(betaGit);
        expect(host.xcrunCalls).toBe(2);
      }).pipe(Effect.provideService(CommandResolutionCache, new Map())),
    );
  });
});

describe("desktop shell environment updates", () => {
  it.each(["linux", "darwin"] as const)(
    "applies shell updates with %s PATH semantics",
    (platform) => {
      const message = decodeDesktopHostMessage({
        version: 1,
        type: "shellEnvironment",
        discovered: true,
        platform,
        environment: {
          PATH: "C:\\fresh",
          FNM_DIR: null,
          __MISE_DIFF: null,
          SSH_AUTH_SOCK: "/current.sock",
          NODE_OPTIONS: "--bad",
        },
      });
      expect(message.type).toBe("shellEnvironment");
      if (message.type !== "shellEnvironment") throw new Error("Expected shell environment update");
      const env: NodeJS.ProcessEnv = {
        Path: "C:\\stale",
        FNM_DIR: "stale",
        __MISE_DIFF: "stale",
        UNRELATED: "keep",
      };
      applyShellEnvironment(env, message.environment, platform);
      expect(env).toEqual({
        PATH: "C:\\fresh",
        Path: "C:\\stale",
        SSH_AUTH_SOCK: "/current.sock",
        UNRELATED: "keep",
      });
      env.Path = "C:\\stale";
      env.path = "C:\\other";
      applyShellEnvironment(env, { PATH: null, SSH_AUTH_SOCK: null }, platform);
      expect(env).toEqual({
        Path: "C:\\stale",
        path: "C:\\other",
        UNRELATED: "keep",
      });
    },
  );
});

describe("pathSetupCommand", () => {
  // Unsupported hosts, ambiguous macOS bash startup files, other shells, and unsafe paths.
  it.each([
    [
      "/home/theo/.local/bin",
      "/bin/bash",
      "linux",
      `printf '\\n%s\\n' 'export PATH="$PATH:/home/theo/.local/bin"' >> ~/.bashrc`,
    ],
    [
      "/Users/theo/.local/bin",
      "/usr/bin/fish",
      "linux",
      `mkdir -p ~/.config/fish && printf '\\n%s\\n' 'fish_add_path --append --path $HOME/.local/bin' >> ~/.config/fish/config.fish`,
    ],
    [
      "/opt/t3/bin",
      "/bin/zsh",
      "linux",
      `printf '\\n%s\\n' 'export PATH="$PATH:/opt/t3/bin"' >> ~/.zshrc`,
    ],
    ["/Users/theo/.local/bin", "/bin/tcsh", "darwin", undefined],
    ["/Users/theo/.local/bin", "/bin/bash", "darwin", undefined],
    ["C:\\Users\\theo\\.local\\bin", "pwsh", "win32", undefined],
    ["/Users/theo/it's here", "/bin/zsh", "darwin", undefined],
    ["/opt/a$PWD/bin", "/bin/zsh", "linux", undefined],
    // Relative: PATH would follow the working directory into any checkout's `bin`.
    ["bin", "/bin/zsh", "linux", undefined],
  ] as const)("%s with %s on %s", (directory, shell, platform, expected) => {
    expect(pathSetupCommand({ directory, home: "/Users/theo", shell, platform })).toBe(expected);
  });

  it("writes the startup file fish and zsh read, under XDG_CONFIG_HOME or ZDOTDIR", () => {
    const setup = { directory: "/opt/t3/bin", home: "/home/theo", shell: "/usr/bin/fish" } as const;
    expect(pathSetup({ ...setup, platform: "linux", configHome: "/home/theo/cfg" })?.file).toBe(
      "/home/theo/cfg/fish/config.fish",
    );
    expect(pathSetup({ ...setup, platform: "linux" })?.file).toBe("~/.config/fish/config.fish");
    // zsh reads .zshrc from ZDOTDIR when it is set.
    expect(
      pathSetup({ ...setup, shell: "/bin/zsh", platform: "darwin", zdotdir: "/Users/theo/.zsh" })
        ?.file,
    ).toBe("/Users/theo/.zsh/.zshrc");
    // A set folder that cannot be written safely means no setup, never the unread default.
    expect(
      pathSetup({ ...setup, shell: "/bin/zsh", platform: "darwin", zdotdir: "/Users/theo/my zsh" }),
    ).toBeUndefined();
    expect(
      pathSetup({ ...setup, platform: "linux", configHome: "/home/theo/my cfg" }),
    ).toBeUndefined();
  });
});

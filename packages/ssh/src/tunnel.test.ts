// @effect-diagnostics nodeBuiltinImport:off - Runs the generated runner in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { captureLauncher, captureLauncherFor, runLauncher } from "./launcherTestHarness.ts";
import * as SshAuth from "./auth.ts";
import { remoteStateKey } from "./command.ts";
import { SshCommandError, SshPasswordPromptError, SshReadinessError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";

const isSshCommandError = Schema.is(SshCommandError);

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(true),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args.map(String) : [];
}

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;

const captureRemoteScript = Effect.fn("test.captureRemoteScript")(function* (
  runner: SshTunnel.RemoteT3RunnerOptions,
  pairing = false,
) {
  let script = "";
  const capture = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const stdin = command._tag === "StandardCommand" ? command.options.stdin : undefined;
      if (
        stdin &&
        typeof stdin === "object" &&
        "stream" in stdin &&
        Stream.isStream(stdin.stream)
      ) {
        const chunks = yield* Stream.runCollect(stdin.stream);
        script = Array.from(chunks, (chunk) => new TextDecoder().decode(chunk)).join("");
      }
      return makeSuccessfulProcess('{"remotePort":3773,"credential":"pair-token"}\n');
    }),
  );
  const target = { alias: "test", hostname: "test", username: null, port: null };
  if (pairing) {
    yield* SshTunnel.issueRemotePairingToken(target, undefined, runner).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, capture),
    );
  } else {
    yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, runner).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, capture),
    );
  }
  return script;
});
// Emulates `t3 serve`: it takes the home owner lock at startup, then binds
// once a second server has tried the same home (or after 2s), so a concurrent
// launch always sees the home still unclaimed. Like the real server, it
// publishes server-runtime.json after it starts answering HTTP, if at all.
const fakeT3Serve = (publishDelayMs: number | null) => `const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const userdata = path.join(args[args.indexOf("--base-dir") + 1], "userdata");
const servers = path.join(process.env.HOME, "servers");
fs.mkdirSync(userdata, { recursive: true });
fs.appendFileSync(servers, process.pid + "\\n");
try {
  fs.writeFileSync(path.join(userdata, "server.lock"), String(process.pid), { flag: "wx" });
} catch {
  console.error("ServerAlreadyRunningError: another server owns " + userdata);
  process.exit(1);
}
setTimeout(() => process.exit(0), 60_000);
const serve = (tries) => {
  if (tries > 0 && fs.readFileSync(servers, "utf8").trim().split("\\n").length < 2) {
    setTimeout(() => serve(tries - 1), 50);
    return;
  }
  http.createServer((_, response) => response.end()).listen(port, "127.0.0.1", () => {
    const origin = "http://127.0.0.1:" + port;
    ${publishDelayMs === null ? "return;" : ""}
    setTimeout(() => {
      fs.writeFileSync(path.join(userdata, "server-runtime.json"), JSON.stringify({ pid: process.pid, port, origin }));
    }, ${publishDelayMs});
  });
};
serve(40);
`;

// The launch's POSIX bootstrap without the account login shell around it, so the
// test machine's login profile cannot move HOME.
const launchStateKey = (command: ChildProcess.Command) =>
  /exec sh -s -- (\S+)"/u.exec(commandArgs(command).join(" "))?.[1];

// Runs the remote half of an SSH launch as a local shell
// whose HOME is the given directory. Every launch after the first starts once
// a server is running (or after 10s), which lines up the race deterministically.
const localRemoteShellLayer = (home: string) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      let launches = 0;
      return ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return spawner.spawn(command);
        const gate =
          launches++ === 0
            ? ""
            : 'i=0; while [ ! -s "$HOME/servers" ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i+1)); done; ';
        return spawner.spawn(
          ChildProcess.make(
            "sh",
            ["-c", `${gate}exec sh -s -- "$1"`, "sh", launchStateKey(command) ?? ""],
            {
              ...command.options,
              env: { ...command.options.env, HOME: home },
              // Like an SSH session ending, the shell's exit leaves its nohup'd server running.
              detached: false,
            },
          ),
        );
      });
    }),
  );

describe("ssh tunnel scripts", () => {
  it.live.each([
    { kind: "managed", downloadFails: false },
    { kind: "external", downloadFails: false },
    { kind: "managed", downloadFails: true },
    { kind: "external", downloadFails: true },
  ])(
    "updates managed servers and leaves external servers running ($kind, $downloadFails)",
    ({ kind, downloadFails }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-update-test-" });
        const stateKey = yield* remoteStateKey({
          alias: "test",
          hostname: "test",
          username: null,
          port: null,
        });
        const state = `${home}/.t3/ssh-launch/${stateKey}`;
        const runtime = `${home}/.t3/runtime/versions/1.2.4`;
        yield* fs.makeDirectory(state, { recursive: true });
        yield* fs.makeDirectory(runtime, { recursive: true });
        const previous = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [
            "-e",
            "setInterval(() => {}, 1000)",
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            "3773",
          ]),
        );
        yield* fs.writeFileString(`${state}/pid`, kind === "managed" ? String(previous.pid) : "");
        yield* fs.writeFileString(`${state}/port`, "3773");
        yield* fs.writeFileString(`${state}/managed`, kind);
        yield* fs.writeFileString(`${state}/run-t3.sh`, "previous runner\n");
        if (downloadFails) {
          yield* fs.writeFileString(`${state}/pinned-runner.sh`, "previous runner\n");
          yield* fs.chmod(`${state}/pinned-runner.sh`, 0o700);
        }
        yield* fs.writeFileString(`${runtime}/.install-complete`, "1.2.4");
        yield* fs.writeFileString(
          `${runtime}/t3`,
          `#!/bin/sh
case "$1" in
  --version) ${downloadFails ? "exit 1" : "echo 1.2.4"} ;;
  __ssh-helper)
    case "$2" in
      runtime-port)
        if [ "$(cat '${state}/managed')" = managed ]; then
          echo "$(cat '${state}/pid') 3773"
        else
          echo '${previous.pid} 3773'
        fi ;;
      wait-ready) exit 0 ;;
      pick-port) echo 3773 ;;
    esac ;;
  serve) exec '${process.execPath}' -e 'setInterval(() => {}, 1000)' "$@" ;;
  auth) echo '{"credential":"pair-token"}' ;;
esac
`,
        );
        yield* fs.chmod(`${runtime}/t3`, 0o700);
        const launchScript = yield* captureRemoteScript({
          archiveVersion: "1.2.4",
          replaceExistingServer: true,
        });
        const child = yield* spawner.spawn(
          ChildProcess.make("sh", ["-s", "--", stateKey], {
            env: { HOME: home },
            stdin: { stream: Stream.make(new TextEncoder().encode(launchScript)) },
          }),
        );
        const exitCode = yield* child.exitCode;
        const spawnedPid = (yield* fs.readFileString(`${state}/pid`)).trim();
        if (spawnedPid && spawnedPid !== String(previous.pid)) {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              try {
                process.kill(Number(spawnedPid), "SIGTERM");
              } catch {
                /* The fixture may already have exited. */
              }
            }),
          );
        }
        const rejected = downloadFails || kind === "external";
        assert.equal(exitCode, rejected ? 1 : 0);
        assert.equal(yield* previous.isRunning, rejected);
        if (kind === "external" && !downloadFails) {
          const chunks = yield* Stream.runCollect(child.stderr);
          assert.include(
            Array.from(chunks, (chunk) => new TextDecoder().decode(chunk)).join(""),
            "outside SSH management",
          );
        }
        if (!rejected) {
          const installedPid = yield* fs.readFileString(`${state}/pid`);
          const olderRuntime = `${home}/.t3/runtime/versions/1.2.3`;
          yield* fs.makeDirectory(olderRuntime, { recursive: true });
          yield* fs.writeFileString(`${olderRuntime}/.install-complete`, "1.2.3");
          yield* fs.writeFileString(`${olderRuntime}/t3`, "#!/bin/sh\necho 1.2.3\n");
          yield* fs.chmod(`${olderRuntime}/t3`, 0o700);
          const reconnect = yield* captureRemoteScript({ archiveVersion: "1.2.3" });
          const reconnected = yield* spawner.spawn(
            ChildProcess.make("sh", ["-s", "--", stateKey], {
              env: { HOME: home },
              stdin: { stream: Stream.make(new TextEncoder().encode(reconnect)) },
            }),
          );
          assert.equal(yield* reconnected.exitCode, 0);
          assert.equal(yield* fs.readFileString(`${state}/pid`), installedPid);
          const pairingScript = yield* captureRemoteScript({ archiveVersion: "1.2.3" }, true);
          const paired = yield* spawner.spawn(
            ChildProcess.make("sh", ["-s"], {
              env: { HOME: home },
              stdin: { stream: Stream.make(new TextEncoder().encode(pairingScript)) },
            }),
          );
          assert.equal(yield* paired.exitCode, 0);
          const runner = yield* spawner.spawn(
            ChildProcess.make(`${state}/run-t3.sh`, ["--version"], { env: { HOME: home } }),
          );
          const chunks = yield* Stream.runCollect(runner.stdout);
          assert.equal(
            Array.from(chunks, (chunk) => new TextDecoder().decode(chunk))
              .join("")
              .trim(),
            "1.2.4",
          );
          assert.equal(yield* runner.exitCode, 0);
        }
        const pid = (yield* fs.readFileString(`${state}/pid`)).trim();
        if (pid && pid !== String(previous.pid)) {
          yield* Effect.sync(() => process.kill(Number(pid), "SIGTERM"));
        }
        if (downloadFails) {
          assert.equal(yield* fs.readFileString(`${state}/run-t3.sh`), "previous runner\n");
          assert.equal(yield* fs.readFileString(`${state}/pinned-runner.sh`), "previous runner\n");
        } else if (kind === "managed") {
          assert.equal((yield* fs.readFileString(`${state}/managed`)).trim(), "managed");
          assert.notEqual(pid, String(previous.pid));
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.succeed(HttpClient.HttpClient, testHttpClient),
          ),
        ),
        Effect.scoped,
      ),
  );

  it.effect("replaces healthy tunnels only for explicit version updates", () => {
    let launches = 0;
    let closed = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const args = commandArgs(command);
        if (args.includes("-G")) return makeSuccessfulProcess("");
        if (args.includes("-N")) return makeRunningProcess(() => closed++);
        if (launchStateKey(command) !== undefined) {
          launches++;
          const stdin = command._tag === "StandardCommand" ? command.options.stdin : undefined;
          if (
            stdin &&
            typeof stdin === "object" &&
            "stream" in stdin &&
            Stream.isStream(stdin.stream)
          ) {
            const chunks = yield* Stream.runCollect(stdin.stream);
            assert.isAbove(chunks.length, 0);
          }
        }
        return makeSuccessfulProcess('{"remotePort":3773,"serverKind":"managed"}\n');
      }),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshAuth.SshPasswordPrompt.disabledLayer,
      SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
    );
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
      yield* manager.ensureEnvironment(target);
      const invalid = yield* Effect.result(
        manager.ensureEnvironment(target, { targetVersion: "../outside" }),
      );
      assert.isTrue(Result.isFailure(invalid));
      assert.equal(closed, 0);
      yield* manager.ensureEnvironment(target, { targetVersion: "1.2.4" });
      assert.equal(launches, 2);
      assert.equal(closed, 1);
      yield* manager.ensureEnvironment(target);
      assert.equal(launches, 2);
      yield* manager.disconnectEnvironment(target);
      yield* manager.ensureEnvironment(target);
      assert.equal(launches, 3);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect.each([
    { version: ARCHIVE.archiveVersion, runner: ARCHIVE },
    { version: "1.2.4", runner: ARCHIVE },
    {
      version: "1.2.4",
      runner: {
        nodeScriptPath: "/opt/t3/server.mjs",
        releaseBaseUrl: "https://releases.example.test/download",
      },
    },
  ])("preserves SSH authentication failures while relaying $version", ({ version, runner }) => {
    let launches = 0;
    const downloads: string[] = [];
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        downloads.push(request.url);
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      }),
    );
    const spawner = ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        const stderr =
          launches++ === 0
            ? `T3_DOWNLOAD_FAILED:t3-${version}-linux-x64.tar.gz\n`
            : "Permission denied (publickey,password).";
        return {
          ...makeSuccessfulProcess(""),
          stderr: Stream.make(new TextEncoder().encode(stderr)),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
        };
      }),
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        SshTunnel.launchOrReuseRemoteServer(
          { alias: "devbox", hostname: "devbox", username: null, port: null },
          undefined,
          runner,
        ),
      );
      assert.isTrue(SshAuth.isSshAuthFailure(error));
      assert.equal(launches, 3);
      assert.equal(downloads.length, 1);
      assert.isTrue(downloads[0]?.endsWith(`/v${version}/SHA256SUMS`));
      if ("releaseBaseUrl" in runner) {
        assert.equal(downloads[0], `${runner.releaseBaseUrl}/v${version}/SHA256SUMS`);
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, httpClient),
        ),
      ),
    );
  });

  it.effect.each([
    { stderr: "Permission denied (publickey).", explicit: false },
    { stderr: "Checksum mismatch for runtime.", explicit: false },
    { stderr: "T3_DOWNLOAD_FAILED:../../other.tar.gz", explicit: false },
    { stderr: "T3_DOWNLOAD_FAILED:t3-../../outside-linux-x64.tar.gz", explicit: false },
    { stderr: "T3_DOWNLOAD_FAILED:t3-1.2.4-linux-x64.tar.gz", explicit: true },
  ])(
    "does not relay invalid launch failures ($stderr, explicit=$explicit)",
    ({ stderr, explicit }) => {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed({
          ...makeSuccessfulProcess(""),
          stderr: Stream.make(new TextEncoder().encode(stderr)),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        }),
      );
      return Effect.gen(function* () {
        const error = yield* Effect.flip(
          SshTunnel.launchOrReuseRemoteServer(
            { alias: "devbox", hostname: "devbox", username: null, port: null },
            undefined,
            { ...ARCHIVE, replaceExistingServer: explicit },
          ),
        );
        assert.instanceOf(error, SshCommandError);
        assert.equal(error.message, stderr);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("Unexpected download")),
            ),
          ),
        ),
      );
    },
  );

  it.live("installs relayed archives only after checking their checksum", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-install-test-" });
        yield* fs.writeFileString(
          `${home}/runner.sh`,
          SshTunnel.buildRemoteT3RunnerScript(ARCHIVE),
        );
        yield* fs.makeDirectory(`${home}/bin`);
        yield* fs.writeFileString(`${home}/bin/curl`, "#!/bin/sh\nexit 28\n");
        yield* fs.writeFileString(
          `${home}/bin/uname`,
          '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n',
        );
        yield* fs.chmod(`${home}/bin/curl`, 0o700);
        yield* fs.chmod(`${home}/bin/uname`, 0o700);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make(
            "sh",
            [
              "-c",
              `set -eu
export PATH="$HOME/bin:$PATH"
cd "$HOME"
if T3_DOWNLOAD_ID=../outside sh runner.sh --version >out 2>err; then exit 1; fi
grep -q 'Invalid t3 download ID' err
if sh runner.sh --version >out 2>err; then exit 1; fi
grep -q '^T3_DOWNLOAD_FAILED:' err
echo 'Remote download failed; relay requested.'
CACHE="$HOME/.t3/runtime/downloads/${ARCHIVE.archiveVersion}/attempt"
export T3_DOWNLOAD_ID=attempt
mkdir -p "$HOME/.t3/runtime/downloads/${ARCHIVE.archiveVersion}/other-attempt"
ARCHIVE="t3-${ARCHIVE.archiveVersion}-linux-x64.tar.gz"
mkdir -p source "$CACHE"
printf '#!/bin/sh\\necho fixture-runtime\\n' > source/t3
chmod 700 source/t3
tar -czf archive.tar.gz source
cp archive.tar.gz "$CACHE/$ARCHIVE"
printf '%064d  %s\\n' 0 "$ARCHIVE" > "$CACHE/SHA256SUMS"
if sh runner.sh --version >out 2>err; then exit 1; fi
grep -q 'Checksum mismatch' err
test ! -e "$CACHE"
test -d "$HOME/.t3/runtime/downloads/${ARCHIVE.archiveVersion}/other-attempt"
echo 'Corrupt relay rejected; cache removed.'
mkdir -p "$CACHE"
cp archive.tar.gz "$CACHE/$ARCHIVE"
(cd "$CACHE"; shasum -a 256 "$ARCHIVE" > SHA256SUMS)
sh runner.sh --version >out
grep -q '^fixture-runtime$' out
test ! -e "$CACHE"
test -d "$HOME/.t3/runtime/downloads/${ARCHIVE.archiveVersion}/other-attempt"
echo 'Verified relay installed and executed.'
`,
            ],
            { env: { HOME: home } },
          ),
        );
        const [code, stdout, stderr] = yield* Effect.all(
          [
            child.exitCode,
            Stream.mkString(Stream.decodeText(child.stdout)),
            Stream.mkString(Stream.decodeText(child.stderr)),
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(Number(code), 0, stderr);
        assert.include(stdout, "Verified relay installed and executed.");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.each([false, true])(
    "relays downloads and cleans its cache (retry fails: %s)",
    (retryFails) =>
      Effect.scoped(
        Effect.gen(function* () {
          const commands: Array<ReadonlyArray<string>> = [];
          const downloads: string[] = [];
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-relay-test-" });
          const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const spawner = ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              commands.push(commandArgs(command));
              if (commands.length === 1) {
                return {
                  ...makeSuccessfulProcess(""),
                  stderr: Stream.make(
                    new TextEncoder().encode(
                      "T3_DOWNLOAD_FAILED:t3-1.2.3-preview.20260911.4-linux-x64.tar.gz\n",
                    ),
                  ),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                };
              }
              const root = `${home}/.t3/runtime/downloads/${ARCHIVE.archiveVersion}`;
              const attempts = yield* fs.readDirectory(root);
              assert.lengthOf(attempts, 1);
              for (const file of ["SHA256SUMS", "t3-1.2.3-preview.20260911.4-linux-x64.tar.gz"]) {
                assert.deepEqual(
                  Array.from(yield* fs.readFile(`${root}/${attempts[0]}/${file}`)),
                  [0, 255, 10, 13, 128],
                );
              }
              return retryFails
                ? {
                    ...makeSuccessfulProcess(""),
                    stderr: Stream.make(new TextEncoder().encode("Retry failed.")),
                    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                  }
                : makeSuccessfulProcess('{"remotePort":3774}\n');
            }),
          );
          const relaySpawner = ChildProcessSpawner.make((command) => {
            if (commandArgs(command).at(-2) === "-c" && launchStateKey(command) === undefined) {
              commands.push(commandArgs(command));
              return nativeSpawner.spawn(
                ChildProcess.make("sh", ["-c", commandArgs(command).slice(-3).join(" ")], {
                  env: { HOME: home },
                  stdin: command._tag === "StandardCommand" ? command.options.stdin : "pipe",
                }),
              );
            }
            return spawner.spawn(command);
          });
          const client = HttpClient.make((request) => {
            if (request.url.startsWith("https://github.com/")) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(null, {
                    status: 302,
                    headers: {
                      location: `https://assets.example/${request.url.split("/").at(-1)}`,
                    },
                  }),
                ),
              );
            }
            downloads.push(request.url);
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(new Uint8Array([0, 255, 10, 13, 128])),
              ),
            );
          });
          return yield* Effect.gen(function* () {
            const launch = SshTunnel.launchOrReuseRemoteServer(
              { alias: "devbox", hostname: "devbox", username: null, port: null },
              undefined,
              ARCHIVE,
            );
            if (retryFails) {
              const error = yield* Effect.flip(launch);
              assert.instanceOf(error, SshCommandError);
              assert.equal(error.message, "Retry failed.");
            } else {
              assert.equal((yield* launch).remotePort, 3774);
            }
            assert.equal(commands.length, 5);
            assert.deepEqual(
              downloads.map((url) => url.split("/").at(-1)),
              ["SHA256SUMS", "t3-1.2.3-preview.20260911.4-linux-x64.tar.gz"],
            );
            assert.deepEqual(
              yield* fs.readDirectory(`${home}/.t3/runtime/downloads/${ARCHIVE.archiveVersion}`),
              [],
            );
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeServices.layer,
                NodeCrypto.layer,
                Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, relaySpawner),
                Layer.succeed(HttpClient.HttpClient, client),
              ),
            ),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("distinguishes an incompatible remote Node from a missing executable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-node-" });
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      for (const missing of [false, true]) {
        const nodeFixture = missing
          ? "command() { return 1; }; "
          : 'node() { cat >/dev/null; printf "Remote node 18.20.8 does not satisfy required range >=999.0.0.\\n" >&2; return 1; }; ';
        const remoteShell = ChildProcessSpawner.make((command) => {
          if (command._tag !== "StandardCommand") return spawner.spawn(command);
          return spawner.spawn(
            ChildProcess.make(
              "sh",
              ["-c", `${nodeFixture}eval "$(cat)"`, "sh", ...commandArgs(command).slice(-1)],
              {
                ...command.options,
                env: {
                  ...command.options.env,
                  HOME: home,
                  NVM_DIR: NodePath.join(home, ".nvm"),
                  FNM_DIR: NodePath.join(home, ".fnm"),
                  VOLTA_HOME: NodePath.join(home, ".volta"),
                },
              },
            ),
          );
        });
        const result = yield* SshTunnel.launchOrReuseRemoteServer(
          { alias: "devbox", hostname: "devbox", username: null, port: null },
          undefined,
          { nodeScriptPath: "/unused/server.ts", nodeEngineRange: ">=999.0.0" },
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, remoteShell),
          Effect.result,
        );
        assert.isTrue(Result.isFailure(result));
        if (!Result.isFailure(result)) return;
        assert.isTrue(isSshCommandError(result.failure));
        if (!isSshCommandError(result.failure)) return;
        assert.equal(result.failure.exitCode, 1);
        assert.equal(result.failure.stderr.includes("missing node on PATH"), missing);
        assert.equal(
          result.failure.stderr.includes("does not satisfy required range >=999.0.0"),
          !missing,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it("rejects archive versions that are not a single exact version segment", () => {
    for (const archiveVersion of [
      "../other",
      "1.2.3/evil",
      "1.2.3\\evil",
      "1.2.3-preview.1 x",
      "1.2.3-preview.1\nrm -rf /",
      "v1.2.3",
    ]) {
      assert.throws(
        () => SshTunnel.buildRemoteT3RunnerScript({ archiveVersion }),
        SshTunnel.SshInvalidArchiveVersionError,
        undefined,
        archiveVersion,
      );
    }
    assert.include(
      SshTunnel.buildRemoteT3RunnerScript(ARCHIVE),
      "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
  });

  it.each([
    { host: "Darwin x86_64", system: "Darwin", machine: "x86_64", downloads: false },
    { host: "Darwin arm64", system: "Darwin", machine: "arm64", downloads: true },
  ])(
    "only downloads a release archive the host can run: $host",
    ({ system, machine, downloads }) => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-runner-"));
      try {
        const bin = NodePath.join(root, "bin");
        NodeFS.mkdirSync(bin);
        NodeFS.mkdirSync(NodePath.join(root, "home"));
        NodeFS.writeFileSync(
          NodePath.join(bin, "uname"),
          `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; esac\n`,
          { mode: 0o755 },
        );
        NodeFS.writeFileSync(
          NodePath.join(bin, "curl"),
          "#!/bin/sh\necho 'download attempt' >&2\necho 'curl: (6) Could not resolve host: github.com' >&2\nexit 6\n",
          { mode: 0o755 },
        );
        const runner = NodePath.join(root, "run-t3.sh");
        NodeFS.writeFileSync(runner, SshTunnel.buildRemoteT3RunnerScript(ARCHIVE));
        const result = NodeChildProcess.spawnSync("sh", [runner, "--version"], {
          encoding: "utf8",
          env: { HOME: NodePath.join(root, "home"), PATH: `${bin}:${process.env.PATH ?? ""}` },
        });
        assert.notEqual(result.status, 0);
        if (downloads) {
          assert.include(result.stderr, "download attempt");
          // A bare curl error does not tell the user that t3 itself could not be downloaded.
          assert.include(result.stderr, ARCHIVE.archiveVersion);
          assert.include(result.stderr, "https://github.com/uiliugang/t3code/releases/download");
        } else {
          assert.notInclude(result.stderr, "download attempt");
          assert.include(result.stderr, "has no t3 release archive.");
        }
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("names gzip when a host with tar but no gzip cannot unpack the release archive", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-runner-"));
    try {
      const bin = NodePath.join(root, "bin");
      const release = NodePath.join(root, "release");
      const archive = `t3-${ARCHIVE.archiveVersion}-linux-x64.tar.gz`;
      NodeFS.mkdirSync(bin);
      NodeFS.mkdirSync(NodePath.join(root, "home"));
      NodeFS.mkdirSync(NodePath.join(release, "t3"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(release, "t3", "t3"), "#!/bin/sh\necho ok\n", {
        mode: 0o755,
      });
      NodeChildProcess.execFileSync("tar", ["-czf", archive, "t3"], { cwd: release });
      NodeChildProcess.execFileSync("sh", ["-c", `sha256sum ${archive} > SHA256SUMS`], {
        cwd: release,
      });
      for (const tool of ["sh", "mkdir", "mktemp", "cat", "rm", "grep", "cut", "sha256sum", "mv"]) {
        NodeFS.symlinkSync(
          NodeChildProcess.execFileSync("sh", ["-c", `command -v ${tool}`], {
            encoding: "utf8",
          }).trim(),
          NodePath.join(bin, tool),
        );
      }
      NodeFS.writeFileSync(
        NodePath.join(bin, "tar"),
        '#!/bin/sh\nprintf "%s\\n" "gzip: not found" >&2\nexit 2\n',
        { mode: 0o755 },
      );
      NodeFS.writeFileSync(
        NodePath.join(bin, "uname"),
        '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n',
        { mode: 0o755 },
      );
      NodeFS.writeFileSync(
        NodePath.join(bin, "curl"),
        `#!/bin/sh\nfor last; do :; done\nfor a; do case "$a" in http*) src="${release}/\${a##*/}" ;; esac; done\nexec cat "$src" > "$last"\n`,
        { mode: 0o755 },
      );
      const runner = NodePath.join(root, "run-t3.sh");
      NodeFS.writeFileSync(runner, SshTunnel.buildRemoteT3RunnerScript(ARCHIVE));
      const result = NodeChildProcess.spawnSync(NodePath.join(bin, "sh"), [runner, "--version"], {
        encoding: "utf8",
        env: { HOME: NodePath.join(root, "home"), PATH: bin },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /(missing|needs) gzip/);
      assert.notInclude(result.stderr, "Cannot exec");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n')),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
      layerSpawner,
    );

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE).pipe(
        Effect.provideService(HttpClient.HttpClient, testHttpClient),
      );
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "loads login settings without changing the POSIX bootstrap or its state key",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-login-" });
        const startupFile = `${directory}/bash-env`;
        const bash = `${directory}/bash`;
        // System profiles can reset HOME. Suppress profile reads while BASH_ENV
        // checks that the launcher still requests Bash login mode.
        yield* fs.writeFileString(bash, '#!/bin/sh\nexec /bin/bash --noprofile "$@"\n');
        yield* fs.chmod(bash, 0o755);
        yield* fs.writeFileString(
          startupFile,
          "if shopt -q login_shell; then export T3_SSH_LOGIN_ENV=loaded; fi\n",
        );
        const target = { alias: "login-test", hostname: "login-test", username: null, port: null };
        let remoteCommand = "";
        const capture = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            const args = commandArgs(command);
            remoteCommand = args.slice(args.indexOf(target.alias) + 1).join(" ");
            return makeSuccessfulProcess('{"remotePort":3774}\n');
          }),
        );
        yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, capture),
        );
        yield* fs.writeFileString(
          `${directory}/.zprofile`,
          "if [[ -o login ]]; then export T3_SSH_LOGIN_ENV=loaded; fi\n",
        );
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const cases = [
          { shell: bash, outerShell: "/bin/sh", expected: "loaded" },
          { shell: "/bin/sh", outerShell: "/bin/sh", expected: "missing" },
          { shell: "", outerShell: "/bin/sh", expected: "missing" },
          { shell: "/unavailable/csh", outerShell: "/bin/sh", expected: "missing" },
          { shell: "/unavailable/tcsh", outerShell: "/bin/sh", expected: "missing" },
          { shell: "/unavailable/pwsh", outerShell: "/bin/sh", expected: "missing" },
        ];
        if (yield* fs.exists("/bin/zsh")) {
          cases.push({ shell: "/bin/zsh", outerShell: "/bin/zsh", expected: "loaded" });
        }
        if (yield* fs.exists("/bin/tcsh")) {
          cases.push({ shell: "/bin/tcsh", outerShell: "/bin/tcsh", expected: "missing" });
        }
        const environment = yield* HostProcess.Environment;
        for (const folder of (environment.PATH ?? "").split(":")) {
          const nu = `${folder}/nu`;
          if (folder && (yield* fs.exists(nu))) {
            cases.push({ shell: nu, outerShell: nu, expected: "missing" });
            break;
          }
        }
        for (const { shell, outerShell, expected } of cases) {
          const child = yield* spawner.spawn(
            ChildProcess.make(outerShell, ["-c", remoteCommand], {
              env: {
                PATH: environment.PATH ?? "/usr/bin:/bin",
                HOME: directory,
                XDG_CONFIG_HOME: directory,
                SHELL: shell,
                BASH_ENV: startupFile,
                ZDOTDIR: directory,
                T3_SSH_LOGIN_ENV: "",
              },
              stdin: {
                stream: Stream.make(
                  new TextEncoder().encode('printf "%s:%s" "${T3_SSH_LOGIN_ENV:-missing}" "$1"'),
                ),
                endOnDone: true,
              },
            }),
          );
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              child.stdout.pipe(
                Stream.decodeText(),
                Stream.runFold(
                  () => "",
                  (a, b) => a + b,
                ),
              ),
              child.stderr.pipe(
                Stream.decodeText(),
                Stream.runFold(
                  () => "",
                  (a, b) => a + b,
                ),
              ),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          assert.equal(Number(exitCode), 0, stderr);
          // First-run shell messages can precede the bootstrap response.
          const response = stdout.trim().split(/\r?\n/u).at(-1) ?? "";
          assert.match(response, new RegExp(`^${expected}:[a-f0-9]{16}$`), shell || "unset SHELL");
        }
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
      layerSpawner,
    );
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("retains a bounded diagnostic tail when the tunnel exits before readiness", () =>
    Effect.gen(function* () {
      const diagnostic = "Connection refused: café";
      const output = new TextEncoder().encode(
        "old diagnostics\n" + "x".repeat(32_768) + "\n" + diagnostic,
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(output.subarray(0, output.length - 1), output.subarray(-1)),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (isSshCommandError(result.failure)) {
            assert.equal(result.failure.exitCode, 1);
            assert.equal(result.failure.stderr.length, 16_384);
            assert.isTrue(result.failure.stderr.endsWith(diagnostic));
            assert.equal(result.failure.message, result.failure.stderr.trim());
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("reports the real exit when reading tunnel diagnostics fails", () =>
    Effect.gen(function* () {
      const diagnostic = "Permission denied (publickey)";
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(diagnostic)).pipe(
                  Stream.concat(
                    Stream.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "Stream",
                        method: "read",
                        description: "stderr read failed",
                      }),
                    ),
                  ),
                ),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (isSshCommandError(result.failure)) {
            assert.equal(result.failure.exitCode, 255);
            assert.equal(result.failure.stderr, diagnostic);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("waits for a tunnel whose ssh connection outlasts the readiness timeout", () =>
    Effect.gen(function* () {
      const LOCAL_PORT = 41_773;
      // ssh spends ConnectTimeout on each unreachable address before the forward listens.
      const SSH_CONNECT_MS = 25_000;
      let forwardListensAt = Number.POSITIVE_INFINITY;
      const tunnelSpawned = yield* Deferred.make<void>();
      const forwardListening = (port: number) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => port === LOCAL_PORT && now >= forwardListensAt),
        );
      const spawner = ChildProcessSpawner.make((command) =>
        commandArgs(command).includes("-N")
          ? Effect.gen(function* () {
              forwardListensAt = (yield* Clock.currentTimeMillis) + SSH_CONNECT_MS;
              yield* Deferred.succeed(tunnelSpawned, undefined);
              return makeRunningProcess(() => undefined);
            })
          : Effect.succeed(makeSuccessfulProcess('{"remotePort":3773}\n')),
      );
      const httpClient = HttpClient.make((request) =>
        forwardListening(LOCAL_PORT).pipe(
          Effect.flatMap((listening) =>
            listening
              ? Effect.succeed(
                  HttpClientResponse.fromWeb(request, new Response("", { status: 200 })),
                )
              : Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      description: `connect ECONNREFUSED 127.0.0.1:${LOCAL_PORT}`,
                    }),
                  }),
                ),
          ),
        ),
      );
      const net = NetService.NetService.of({
        ...testNetService,
        reserveLoopbackPort: () => Effect.succeed(LOCAL_PORT),
        canListenOnHost: (port) =>
          forwardListening(port).pipe(Effect.map((listening) => !listening)),
        isPortAvailableOnLoopback: (port) =>
          forwardListening(port).pipe(Effect.map((listening) => !listening)),
        hasListenerOnHost: (port) => forwardListening(port),
      });
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, net),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const ensure = yield* Effect.forkChild(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        yield* Deferred.await(tunnelSpawned);
        yield* TestClock.adjust(Duration.seconds(60));
        const environment = yield* Fiber.join(ensure);
        assert.equal(environment.httpBaseUrl, `http://127.0.0.1:${LOCAL_PORT}/`);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("connects and reuses a tunnel whose responses take over a second", () =>
    Effect.gen(function* () {
      // Over a ~1s RTT link each request through the forward takes a few round trips.
      const RESPONSE_MS = 2_500;
      const tunnelSpawned = yield* Deferred.make<void>();
      const reconnectProbed = yield* Deferred.make<void>();
      const forwardReplaced = yield* Deferred.make<void>();
      let forwards = 0;
      let connected = false;
      const spawner = ChildProcessSpawner.make((command) =>
        commandArgs(command).includes("-N")
          ? Effect.sync(() => ++forwards).pipe(
              Effect.flatMap((count) =>
                Deferred.succeed(count === 1 ? tunnelSpawned : forwardReplaced, undefined),
              ),
              Effect.as(makeRunningProcess(() => undefined)),
            )
          : Effect.succeed(makeSuccessfulProcess('{"remotePort":3773}\n')),
      );
      const httpClient = HttpClient.make((request) =>
        Effect.gen(function* () {
          if (connected) yield* Deferred.succeed(reconnectProbed, undefined);
          yield* Effect.sleep(Duration.millis(RESPONSE_MS));
          return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const ensure = yield* Effect.forkChild(
          Effect.result(
            manager.ensureEnvironment({
              alias: "devbox",
              hostname: "devbox",
              username: null,
              port: null,
            }),
          ),
        );
        yield* Deferred.await(tunnelSpawned);
        yield* TestClock.adjust(Duration.seconds(60));
        const result = yield* Fiber.join(ensure);
        assert.isTrue(
          Result.isSuccess(result),
          Result.isFailure(result) ? result.failure.message : undefined,
        );
        if (Result.isFailure(result)) return;

        connected = true;
        const reconnect = yield* Effect.forkChild(manager.ensureEnvironment(result.success.target));
        yield* Deferred.await(reconnectProbed);
        yield* TestClock.adjust(Duration.seconds(60));
        const outcome = yield* Effect.raceFirst(
          Fiber.join(reconnect).pipe(Effect.map((environment) => environment.httpBaseUrl)),
          Deferred.await(forwardReplaced).pipe(Effect.as("replaced the forward")),
        );
        assert.equal(outcome, result.success.httpBaseUrl);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("reconnects a saved alias through the port its ssh config names now", () =>
    Effect.gen(function* () {
      let configPort = 53_791;
      const tunnelPorts: Array<string | undefined> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        const args = commandArgs(command);
        if (args.includes("-G")) {
          return Effect.succeed(
            makeSuccessfulProcess(`hostname 127.0.0.1\nuser developer\nport ${configPort}\n`),
          );
        }
        if (args.includes("-N")) {
          tunnelPorts.push(args[args.indexOf("-p") + 1]);
          return Effect.succeed(makeRunningProcess(() => undefined));
        }
        return Effect.succeed(makeSuccessfulProcess('{"remotePort":3773}\n'));
      });
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const added = yield* manager.ensureEnvironment({
          alias: "lima-sandbox",
          hostname: "lima-sandbox",
          username: null,
          port: null,
        });
        // The VM restarts on a new port; the client reconnects with the target it saved.
        yield* manager.disconnectEnvironment(added.target);
        configPort = 53_812;
        yield* manager.ensureEnvironment(added.target);
        assert.deepStrictEqual(tunnelPorts, ["53791", "53812"]);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("fails with a readiness error when ssh never connects", () =>
    Effect.gen(function* () {
      const tunnelSpawned = yield* Deferred.make<void>();
      let tunnelKilled = false;
      const spawner = ChildProcessSpawner.make((command) =>
        commandArgs(command).includes("-N")
          ? Deferred.succeed(tunnelSpawned, undefined).pipe(
              Effect.as(
                makeRunningProcess(() => {
                  tunnelKilled = true;
                }),
              ),
            )
          : Effect.succeed(makeSuccessfulProcess('{"remotePort":3773}\n')),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(
          NetService.NetService,
          NetService.NetService.of({
            ...testNetService,
            hasListenerOnHost: () => Effect.succeed(false),
          }),
        ),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const ensure = yield* Effect.forkChild(
          Effect.result(
            manager.ensureEnvironment({
              alias: "devbox",
              hostname: "devbox",
              username: null,
              port: null,
            }),
          ),
        );
        yield* Deferred.await(tunnelSpawned);
        yield* TestClock.adjust(Duration.minutes(2));
        const result = yield* Fiber.join(ensure);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshReadinessError);
          assert.include(result.failure.message, "SSH connection to devbox did not come up");
        }
        assert.isTrue(tunnelKilled);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each([
    {
      name: "does not ask for a password when the agent cannot sign an accepted key",
      stderr:
        'sign_and_send_pubkey: signing failed for ED25519 "/home/julius/.ssh/id_ed25519" from agent: communication with agent failed\r\n' +
        "julius@devbox: Permission denied (publickey,password).\r\n",
      expectedPromptAttempts: [],
    },
    {
      name: "asks for a password when signing failure has no agent provenance",
      stderr:
        'sign_and_send_pubkey: signing failed for ED25519-CERT "key-cert.pub": agent refused operation\n' +
        "julius@devbox: Permission denied (publickey,password).\n",
      expectedPromptAttempts: [1],
    },
    {
      name: "does not ask for a password when the host key cannot be verified",
      stderr: "Host key verification failed.\r\n",
      expectedPromptAttempts: [],
    },
    {
      name: "asks for a password when the server rejects every key",
      stderr: "julius@devbox: Permission denied (publickey,password).\r\n",
      expectedPromptAttempts: [1],
    },
  ])("$name", ({ stderr, expectedPromptAttempts }) =>
    Effect.gen(function* () {
      const promptAttempts: Array<number> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-G")
            ? makeSuccessfulProcess("")
            : {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(stderr)),
              },
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        Layer.succeed(
          SshAuth.SshPasswordPrompt,
          SshAuth.SshPasswordPrompt.of({
            isAvailable: true,
            request: (request) =>
              Effect.sync(() => {
                promptAttempts.push(request.attempt);
                return null;
              }),
          }),
        ),
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        assert.deepEqual(promptAttempts, expectedPromptAttempts);
        if (Result.isFailure(result)) {
          if (expectedPromptAttempts.length === 0) {
            assert.instanceOf(result.failure, SshCommandError);
            if (isSshCommandError(result.failure)) {
              assert.equal(result.failure.stderr, stderr);
            }
          } else {
            assert.instanceOf(result.failure, SshPasswordPromptError);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each(["local tunnel", "remote server"] as const)(
    "waits for %s shutdown before reconnecting the same target",
    (stalledStep) =>
      Effect.gen(function* () {
        const shutdownStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const reconnectsStarted = yield* Deferred.make<void>();
        const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishShutdown)),
        );
        let resolutions = 0;
        let launches = 0;
        let tunnels = 0;
        let stops = 0;
        let remoteRunning = false;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            const isTarget = args.includes(target.alias);
            if (args.includes("-G")) {
              if (isTarget && ++resolutions === 4) {
                yield* Deferred.succeed(reconnectsStarted, undefined);
              }
              return makeSuccessfulProcess("");
            }
            if (args.includes("-N")) {
              const tunnel = makeRunningProcess(() => undefined);
              if (isTarget && ++tunnels === 1 && stalledStep === "local tunnel") {
                return {
                  ...tunnel,
                  kill: (options?: ChildProcess.KillOptions) =>
                    pauseShutdown.pipe(Effect.andThen(tunnel.kill(options))),
                };
              }
              return tunnel;
            }
            if (args.includes("-c")) {
              if (isTarget) {
                launches += 1;
                remoteRunning = true;
              }
              return makeSuccessfulProcess('{"remotePort":3773}\n');
            }
            const stop = makeSuccessfulProcess('{"stopped":true}\n');
            if (!isTarget) return stop;
            const pause = ++stops === 1 && stalledStep === "remote server";
            return {
              ...stop,
              exitCode: (pause ? pauseShutdown : Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    remoteRunning = false;
                    return ChildProcessSpawner.ExitCode(0);
                  }),
                ),
              ),
            };
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(target);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
          yield* Deferred.await(shutdownStarted);
          const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          yield* Deferred.await(reconnectsStarted);

          yield* manager.ensureEnvironment({
            alias: "other",
            hostname: "other",
            username: null,
            port: null,
          });
          yield* TestClock.adjust(Duration.zero);
          const launchesBeforeShutdown = launches;
          yield* Deferred.succeed(finishShutdown, undefined);
          yield* Fiber.join(disconnect);
          const first = yield* Fiber.join(firstReconnect);
          const second = yield* Fiber.join(secondReconnect);

          assert.equal(launchesBeforeShutdown, 1);
          assert.equal(launches, 2);
          assert.equal(tunnels, 2);
          assert.isTrue(remoteRunning);
          assert.equal(first.httpBaseUrl, second.httpBaseUrl);
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );

  it.live("concurrent launches on one remote home record the server that owns it", () =>
    // The second row's server never publishes server-runtime.json.
    Effect.forEach([1_500, null], (publishDelayMs) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-launch-" });
        const serversFile = path.join(home, "servers");
        yield* Effect.addFinalizer(() =>
          fs.readFileString(serversFile).pipe(
            Effect.map((pids) => {
              for (const pid of pids.split("\n").filter(Boolean)) {
                try {
                  process.kill(Number(pid), "SIGKILL");
                } catch {}
              }
            }),
            Effect.ignore,
          ),
        );
        const serverScript = path.join(home, "fake-t3.cjs");
        yield* fs.writeFileString(serverScript, fakeT3Serve(publishDelayMs));
        // A launch that died holding the lock must not block or double-admit later ones.
        const launchLock = path.join(home, ".t3", "ssh-launch", ".launch.lock");
        yield* fs.makeDirectory(path.dirname(launchLock), { recursive: true });
        yield* fs.writeFileString(launchLock, "999999999\n");
        const targets = [
          { alias: "devbox", hostname: "devbox", username: null, port: null },
          { alias: "devbox-tailnet", hostname: "devbox-tailnet", username: null, port: null },
        ];

        const launches = yield* Effect.forEach(
          targets,
          (target) =>
            SshTunnel.launchOrReuseRemoteServer(target, undefined, {
              nodeScriptPath: serverScript,
            }),
          { concurrency: "unbounded" },
        ).pipe(Effect.provide(localRemoteShellLayer(home)));

        const ownerPid = Number(
          yield* fs.readFileString(path.join(home, ".t3", "userdata", "server.lock")),
        );
        assert.sameMembers(
          launches.map((launch) => launch.remoteServerKind),
          ["managed", "external"],
        );
        assert.equal(launches[0]!.remotePort, launches[1]!.remotePort);
        assert.deepEqual((yield* fs.readFileString(serversFile)).trim().split("\n"), [
          String(ownerPid),
        ]);
        for (const [index, launch] of launches.entries()) {
          if (launch.remoteServerKind !== "managed") continue;
          const stateKey = yield* remoteStateKey(targets[index]!);
          const recordedPid = yield* fs.readFileString(
            path.join(home, ".t3", "ssh-launch", stateKey, "pid"),
          );
          assert.equal(
            Number(recordedPid.trim()),
            ownerPid,
            `${targets[index]!.alias} reported a managed server, but its recorded PID is not the server that owns the remote home`,
          );
        }
        assert.isFalse(yield* fs.exists(launchLock));
      }).pipe(Effect.scoped),
    ).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer)),
    ),
  );
});

// On Linux kill -0 accepts a thread ID and kill <tid> signals its whole process,
// but ps lists only thread-group leaders. After a reboot the managed pid file can
// name a thread or a whole process that is not our server.
describe.runIf(HostProcess.Platform.defaultValue() === "linux")("stale managed pid file", () => {
  const FAKE_SERVER = `const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const server = http.createServer((_request, response) => response.end("ok"));
server.listen(Number(flag("--port") ?? 0), "127.0.0.1", () => {
  const port = server.address().port;
  const base = flag("--base-dir");
  if (base) {
    fs.mkdirSync(path.join(base, "userdata"), { recursive: true });
    fs.writeFileSync(
      path.join(base, "userdata", "server-runtime.json"),
      JSON.stringify({ version: 1, pid: process.pid, port, origin: "http://127.0.0.1:" + port }),
    );
  }
  console.log(port);
});
`;
  const target = { alias: "devbox", hostname: "devbox", username: null, port: null } as const;
  const staleIds = ["a thread of an unrelated process", "an unrelated process"] as const;

  const isRunning = (pid: number) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(`/proc/${pid}/stat`)).pipe(
      Effect.map((stat) => !/^\d+ \(.*\) Z/u.test(stat)),
      Effect.orElseSucceed(() => false),
    );

  const prepare = (staleId: (typeof staleIds)[number]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stale-pid-" });
      const home = `${root}/home`;
      const fakeServer = `${root}/fake-t3.cjs`;
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.writeFileString(fakeServer, FAKE_SERVER);
      // Runs the remote command locally under the temp HOME. setsid keeps a launched server alive
      // when the command's process group goes away, as sshd would.
      const sshAsLocalShell = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand" || command.command !== "ssh") {
          return realSpawner.spawn(command);
        }
        if (command.args.includes("-G")) return Effect.succeed(makeSuccessfulProcess(""));
        const stateKey = launchStateKey(command);
        const remoteArgs =
          stateKey === undefined
            ? command.args.slice(command.args.indexOf("--") + 2)
            : ["sh", "-s", "--", stateKey];
        return realSpawner.spawn(
          ChildProcess.make("setsid", ["-w", ...remoteArgs], {
            ...command.options,
            env: { PATH: process.env.PATH ?? "", HOME: home },
            extendEnv: false,
          }),
        );
      });
      const holder = yield* realSpawner.spawn(ChildProcess.make("node", [fakeServer]));
      const holderPort = Number(
        Option.getOrThrow(
          yield* holder.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead),
        ),
      );
      const tid = Number(
        (yield* fs.readDirectory(`/proc/${holder.pid}/task`)).find(
          (task) => task !== `${holder.pid}`,
        ),
      );
      assert.isTrue(Number.isInteger(tid));
      return {
        fs,
        home,
        fakeServer,
        holder,
        holderPort,
        sshAsLocalShell,
        staleId: staleId === "an unrelated process" ? holder.pid : tid,
        stateDir: `${home}/.t3/ssh-launch/${yield* remoteStateKey(target)}`,
      };
    });

  it.live.each(staleIds)("launches a fresh server when the managed pid file names %s", (kind) =>
    Effect.gen(function* () {
      const { fs, home, fakeServer, holderPort, sshAsLocalShell, staleId, stateDir } =
        yield* prepare(kind);
      const launch = SshTunnel.launchOrReuseRemoteServer(target, undefined, {
        nodeScriptPath: fakeServer,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, sshAsLocalShell));
      const readPid = fs
        .readFileString(`${stateDir}/pid`)
        .pipe(Effect.map((pid) => Number(pid.trim())));
      const launchedPids: Array<number> = [];
      yield* Effect.addFinalizer(() =>
        Effect.forEach(launchedPids, (pid) =>
          Effect.sync(() => {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }),
        ),
      );

      const first = yield* launch;
      const firstPid = yield* readPid;
      launchedPids.push(firstPid);
      assert.deepEqual(yield* launch, first);
      assert.equal(yield* readPid, firstPid);

      // Reboot: our server is gone and its recorded PID now names something that
      // answers on the recorded port.
      process.kill(firstPid, "SIGKILL");
      yield* fs.remove(`${home}/.t3/userdata/server-runtime.json`);
      yield* fs.writeFileString(`${stateDir}/pid`, `${staleId}\n`);
      yield* fs.writeFileString(`${stateDir}/port`, `${holderPort}\n`);

      const relaunched = yield* launch;
      const pid = yield* readPid;
      if (pid !== staleId) launchedPids.push(pid);
      assert.notEqual(
        relaunched.remotePort,
        holderPort,
        `the launcher kept ${kind} as its running server`,
      );
      assert.isTrue(yield* isRunning(pid));
    }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer)),
    ),
  );

  it.live.each(staleIds)("disconnecting does not signal %s named by the managed pid file", (kind) =>
    Effect.gen(function* () {
      const { fs, holder, sshAsLocalShell, staleId, stateDir } = yield* prepare(kind);
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(`${stateDir}/pid`, `${staleId}\n`);
      yield* fs.writeFileString(`${stateDir}/managed`, "managed\n");
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, sshAsLocalShell),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );

      yield* Effect.flatMap(SshTunnel.SshEnvironmentManager, (manager) =>
        manager.disconnectEnvironment(target),
      ).pipe(Effect.provide(layer));
      assert.isTrue(yield* isRunning(holder.pid), `disconnecting signalled ${kind}`);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too.

describe("SSH launch during desktop update", () => {
  it.effect("archive launcher reuses the replacement without host Node", () =>
    Effect.gen(function* () {
      const script = yield* captureLauncherFor({ archiveVersion: "1.2.3" });
      const result = runLauncher(script, {
        archive: true,
        marker: { startedAt: 0, expiresAt: 60_000 },
        readyAt: 2_000,
      });
      assert.deepEqual(result.output, { remotePort: 4888, serverKind: "external" });
      assert.equal(result.now, 2_000);
      assert.isFalse(result.events.some((event) => event.startsWith("start ")));
    }),
  );

  it.effect.each(["managed", "external"] as const)(
    "reuses recorded %s server without runtime metadata or an update wait",
    (recordedKind) =>
      Effect.gen(function* () {
        const result = runLauncher(yield* captureLauncher, {
          marker: { startedAt: 0, expiresAt: 60_000 },
          recordedKind,
        });
        assert.deepEqual(result.output, { remotePort: 5999, serverKind: recordedKind });
        assert.equal(result.now, 0);
        assert.isFalse(result.events.some((event) => event.startsWith("kill ")));
        assert.isFalse(result.events.some((event) => event.startsWith("start ")));
      }),
  );

  it.effect.each([
    ["malformed", "broken"],
    ["future", { startedAt: 1_000, expiresAt: 61_000 }],
    ["expired", { startedAt: -60_000, expiresAt: 0 }],
  ] as const)("preserves %s markers without waiting", ([, marker]) =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, { marker });
      assert.equal(result.now, 0);
      assert.isTrue(result.markerExists);
      assert.deepEqual(result.output, { remotePort: 5999, serverKind: "managed" });
    }),
  );

  it.effect("bounds the wait when the host clock jumps back", () =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, {
        marker: { startedAt: 0, expiresAt: 60_000 },
        clockJump: -30_000,
      });
      assert.deepEqual(result.output, { remotePort: 5999, serverKind: "managed" });
      assert.isBelow(result.events.filter((event) => event.startsWith("runtime ")).length, 62);
    }),
  );

  it.effect("refreshes runtime after readiness removes the marker between polls", () =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, {
        marker: { startedAt: 0, expiresAt: 60_000 },
        readyAt: 8_000,
        clearMarkerOnReady: true,
      });
      assert.deepEqual(result.output, { remotePort: 4888, serverKind: "external" });
      assert.equal(result.now, 8_000);
      assert.isFalse(result.markerExists);
      assert.isFalse(result.events.some((event) => event.startsWith("start ")));
      assert.isFalse(result.events.some((event) => event.startsWith("kill ")));
    }),
  );

  it.effect("reuses a runtime published before the first marker read", () =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, {
        marker: { startedAt: 0, expiresAt: 60_000 },
        publishAfterFirstRuntimeRead: true,
      });
      assert.deepEqual(result.output, { remotePort: 4888, serverKind: "external" });
      assert.equal(result.now, 0);
      assert.isFalse(result.events.some((event) => event.startsWith("start ")));
    }),
  );

  it.effect("waits across the eight-second installer gap and reuses the replacement server", () =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, {
        marker: { startedAt: 0, expiresAt: 60_000 },
        readyAt: 8_000,
      });
      assert.deepEqual(result.output, { remotePort: 4888, serverKind: "external" });
      assert.equal(result.now, 8_000);
      assert.isFalse(result.events.some((event) => event.startsWith("start ")));
      assert.isAtLeast(result.events.filter((event) => event.startsWith("runtime ")).length, 2);
    }),
  );

  it.effect("keeps waiting while a stale runtime record points at a dead port", () =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, {
        marker: { startedAt: 0, expiresAt: 60_000 },
        initialPort: 3773,
        readyAt: 3_000,
      });
      assert.deepEqual(result.output, { remotePort: 4888, serverKind: "external" });
      assert.equal(result.now, 3_000);
      assert.isFalse(result.events.some((event) => event.startsWith("start ")));
    }),
  );

  it.effect("starts a server when the marker expires without a replacement becoming ready", () =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, {
        marker: { startedAt: 0, expiresAt: 60_000 },
      });
      assert.deepEqual(result.output, { remotePort: 5999, serverKind: "managed" });
      assert.isAtLeast(result.now, 60_000);
      assert.isAtMost(result.now, 61_000);
      assert.isTrue(result.markerExists, "an expired marker is ignored, not deleted");
      assert.equal(result.events.filter((event) => event.startsWith("start ")).length, 1);
    }),
  );

  it.effect("starts immediately without a marker", () =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, {});
      assert.deepEqual(result.output, { remotePort: 5999, serverKind: "managed" });
      assert.equal(result.now, 0);
      assert.equal(result.events.filter((event) => event.startsWith("start ")).length, 1);
      assert.equal(result.events.filter((event) => event.startsWith("marker ")).length, 1);
      assert.equal(result.events.filter((event) => event.startsWith("runtime ")).length, 1);
    }),
  );
});

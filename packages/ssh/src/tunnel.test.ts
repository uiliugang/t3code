import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
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

describe("ssh tunnel scripts", () => {
  it.live.each([
    { kind: "managed", downloadFails: false },
    { kind: "external", downloadFails: false },
    { kind: "managed", downloadFails: true },
    { kind: "external", downloadFails: true },
  ])(
    "updates $kind servers only after a successful download ($downloadFails)",
    ({ kind, downloadFails }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-update-test-" });
        const state = `${home}/.t3/ssh-launch/test`;
        const runtime = `${home}/.t3/runtime/versions/1.2.4`;
        yield* fs.makeDirectory(state, { recursive: true });
        yield* fs.makeDirectory(runtime, { recursive: true });
        const previous = yield* spawner.spawn(
          ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1000)"]),
        );
        yield* fs.writeFileString(`${state}/pid`, kind === "managed" ? String(previous.pid) : "");
        yield* fs.writeFileString(`${state}/port`, "3773");
        yield* fs.writeFileString(`${state}/managed`, kind);
        yield* fs.writeFileString(`${state}/run-t3.sh`, "previous runner\n");
        yield* fs.writeFileString(`${runtime}/.install-complete`, "1.2.4");
        yield* fs.writeFileString(
          `${runtime}/t3`,
          `#!/bin/sh
case "$1" in
  --version) ${downloadFails ? "exit 1" : "echo 1.2.4"} ;;
  __ssh-helper)
    case "$2" in
      runtime-port) echo '${previous.pid} 3773' ;;
      wait-ready) exit 0 ;;
      pick-port) echo 3773 ;;
    esac ;;
  serve) exec '${process.execPath}' -e 'setInterval(() => {}, 1000)' ;;
esac
`,
        );
        yield* fs.chmod(`${runtime}/t3`, 0o700);
        let launchScript = "";
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
              launchScript = Array.from(chunks, (chunk) => new TextDecoder().decode(chunk)).join(
                "",
              );
            }
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }),
        );
        yield* SshTunnel.launchOrReuseRemoteServer(
          { alias: "test", hostname: "test", username: null, port: null },
          undefined,
          { archiveVersion: "1.2.4", replaceExistingServer: true },
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, capture));
        const child = yield* spawner.spawn(
          ChildProcess.make("sh", ["-s", "--", "test"], {
            env: { HOME: home },
            stdin: { stream: Stream.make(new TextEncoder().encode(launchScript)) },
          }),
        );
        const exitCode = yield* child.exitCode;
        const pid = (yield* fs.readFileString(`${state}/pid`)).trim();
        if (pid && pid !== String(previous.pid)) {
          yield* Effect.sync(() => process.kill(Number(pid), "SIGTERM"));
        }
        assert.equal(exitCode, downloadFails ? 1 : 0);
        assert.equal(yield* previous.isRunning, downloadFails);
        if (downloadFails) {
          assert.equal(yield* fs.readFileString(`${state}/run-t3.sh`), "previous runner\n");
        } else {
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

  it.effect(
    "replaces a healthy tunnel on update and reuses the updated runner on reconnect",
    () => {
      let launches = 0;
      let closed = 0;
      const launchScripts: string[] = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const args = commandArgs(command);
          if (args.includes("-G")) return makeSuccessfulProcess("");
          if (args.includes("-N")) return makeRunningProcess(() => closed++);
          if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
            launches++;
            const stdin = command._tag === "StandardCommand" ? command.options.stdin : undefined;
            if (
              stdin &&
              typeof stdin === "object" &&
              "stream" in stdin &&
              Stream.isStream(stdin.stream)
            ) {
              const chunks = yield* Stream.runCollect(stdin.stream);
              launchScripts.push(
                Array.from(chunks, (chunk) => new TextDecoder().decode(chunk)).join(""),
              );
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
        assert.isTrue(launchScripts[2]?.includes("T3_ARCHIVE_VERSION='1.2.4'"));
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
  );

  it.effect("preserves SSH authentication failures during relay uploads", () => {
    let launches = 0;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        const stderr =
          launches++ === 0
            ? "T3_DOWNLOAD_FAILED:t3-1.2.3-preview.20260911.4-linux-x64.tar.gz\n"
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
          ARCHIVE,
        ),
      );
      assert.isTrue(SshAuth.isSshAuthFailure(error));
      assert.equal(launches, 3);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
        ),
      ),
    );
  });

  it.effect.each([
    "Permission denied (publickey).",
    "Checksum mismatch for runtime.",
    "T3_DOWNLOAD_FAILED:../../other.tar.gz",
  ])("does not relay unrelated or invalid launch failures: %s", (stderr) => {
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
          ARCHIVE,
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
  });

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
            if (commandArgs(command).at(-2) === "-c") {
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

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
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
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(layerProcess));
  });

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
            if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
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
});

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too.

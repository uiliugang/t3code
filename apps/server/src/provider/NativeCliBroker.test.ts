// @effect-diagnostics nodeBuiltinImport:off - Exercises the actual CLI subprocess and private local socket.
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as NativeCli from "./NativeCli.ts";
import * as NativeCliBroker from "./NativeCliBroker.ts";
import type * as Protocol from "./nativeCliProtocol.ts";

const bin = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));

it.live(
  "passes stdin, arguments, credentials, cwd and exit status while retaining the provider lease",
  () =>
    Effect.gen(function* () {
      if (yield* HostProcess.isWindows) return;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const longTemporaryDirectory = NodePath.join(config.stateDir, "temporary-".repeat(12));
      yield* fs.makeDirectory(longTemporaryDirectory, { recursive: true });
      const released = yield* Deferred.make<void>();
      let received: typeof Protocol.Request.Type | undefined;
      const resolve = Effect.fn("test.nativeCli.resolve")(function* (
        request: typeof Protocol.Request.Type,
      ) {
        received = request;
        yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
        return {
          ok: true as const,
          command: process.execPath,
          args: [
            "-e",
            `
        let input = '';
        process.stdin.on('data', chunk => { input += chunk; });
        process.stdin.on('end', () => {
          console.log(JSON.stringify({ input, cwd: process.cwd(), key: process.env.T3_TEST_KEY, old: process.env.OPENAI_API_KEY, path: process.env.PATH }));
          process.exitCode = 23;
        });
      `,
          ],
          environment: { T3_TEST_KEY: "selected-account", OPENAI_API_KEY: null },
        };
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            NativeCliBroker.layer.pipe(
              Layer.provide(Layer.succeed(NativeCli.NativeCli, { resolve })),
              Layer.provide(
                Layer.succeed(HostProcess.Environment, { TMPDIR: longTemporaryDirectory }),
              ),
            ),
          );
          const endpoint = yield* fs.readFileString(
            NodePath.join(config.stateDir, "native-cli.json"),
          );
          expect(endpoint.startsWith("/tmp/t3-cli-")).toBe(true);
          expect(Buffer.byteLength(endpoint)).toBeLessThanOrEqual(100);
          const result = yield* Effect.promise(
            () =>
              new Promise<{ code: number | null; stdout: string; stderr: string }>(
                (done, reject) => {
                  const child = NodeChildProcess.spawn(
                    process.execPath,
                    [
                      bin,
                      "__provider-cli",
                      config.stateDir,
                      "codex",
                      "--t3-instance",
                      "chosen",
                      "--model",
                      "native model",
                      "prompt with spaces",
                    ],
                    {
                      cwd: config.stateDir,
                      env: {
                        ...process.env,
                        T3CODE_THREAD_ID: "linked-thread",
                        OPENAI_API_KEY: "wrong-account",
                        PATH: "/terminal/nvm/bin",
                      },
                      stdio: "pipe",
                    },
                  );
                  let stdout = "";
                  let stderr = "";
                  child.stdout.on("data", (data) => {
                    stdout += data;
                  });
                  child.stderr.on("data", (data) => {
                    stderr += data;
                  });
                  child.once("error", reject);
                  child.once("close", (code) => done({ code, stdout, stderr }));
                  child.stdin.end("input with spaces\n");
                },
              ),
          );
          expect(result.stderr).toBe("");
          expect(result.code).toBe(23);
          expect(JSON.parse(result.stdout)).toEqual({
            input: "input with spaces\n",
            cwd: config.stateDir,
            key: "selected-account",
            path: "/terminal/nvm/bin",
          });
          expect(received).toEqual({
            command: "codex",
            threadId: "linked-thread",
            instanceId: "chosen",
            args: ["--model", "native model", "prompt with spaces"],
          });
          yield* Deferred.await(released);
        }),
      );
      expect(yield* fs.exists(NodePath.join(config.stateDir, "native-cli.json"))).toBe(false);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "native-cli-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
);

it.live("forwards an interrupt to the native child and preserves its signal exit code", () =>
  Effect.gen(function* () {
    if (yield* HostProcess.isWindows) return;
    const config = yield* ServerConfig.ServerConfig;
    const resolve: NativeCli.NativeCli["Service"]["resolve"] = () =>
      Effect.succeed({
        ok: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume(); console.log('ready');"],
        environment: {},
      });
    yield* Layer.build(
      NativeCliBroker.layer.pipe(Layer.provide(Layer.succeed(NativeCli.NativeCli, { resolve }))),
    );
    const code = yield* Effect.promise(
      () =>
        new Promise<number | null>((done, reject) => {
          const child = NodeChildProcess.spawn(
            process.execPath,
            [bin, "__provider-cli", config.stateDir, "claude"],
            { stdio: "pipe" },
          );
          child.stdout.once("data", () => child.kill("SIGINT"));
          child.once("error", reject);
          child.once("close", done);
        }),
    );
    expect(code).toBe(130);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "native-cli-signal-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);

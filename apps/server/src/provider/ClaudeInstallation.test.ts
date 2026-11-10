import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ClaudeInstallation from "./ClaudeInstallation.ts";

const harness = Effect.fn("ClaudeInstallation.test.harness")(function* (
  mode: "success" | "failure" | "mismatch" | "blocked" = "success",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  const entered = yield* Deferred.make<void>();
  const killed = yield* Deferred.make<void>();
  const calls: {
    command: string;
    args: ReadonlyArray<string>;
    env: NodeJS.ProcessEnv | undefined;
  }[] = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const input = command as unknown as {
        command: string;
        args: ReadonlyArray<string>;
        options: { env?: NodeJS.ProcessEnv };
      };
      calls.push({ command: input.command, args: input.args, env: input.options.env });
      const installing = input.args[0] === "install";
      if (installing) {
        yield* Deferred.succeed(entered, undefined);
        const record = path.join(
          directory,
          "tools/claude/lib/node_modules/@anthropic-ai/claude-code/package.json",
        );
        yield* fs.makeDirectory(path.dirname(record), { recursive: true });
        yield* fs.writeFileString(record, JSON.stringify({ version: "2.1.314" }));
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode:
          installing && mode === "blocked"
            ? Effect.never
            : Effect.succeed(
                ChildProcessSpawner.ExitCode(installing && mode === "failure" ? 1 : 0),
              ),
        isRunning: Effect.succeed(false),
        kill: () => Deferred.succeed(killed, undefined).pipe(Effect.asVoid),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(
          new TextEncoder().encode(
            input.args[0] === "view"
              ? '"2.1.314"'
              : mode === "mismatch"
                ? "2.1.300 (Claude Code)"
                : "2.1.314 (Claude Code)",
          ),
        ),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const context = yield* Layer.build(
    ClaudeInstallation.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(directory, directory),
          Layer.succeed(HostProcess.Platform, "linux"),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.mock(ModelManifest.ModelManifest)({
            current: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
          }),
        ),
      ),
    ),
  );
  const service = yield* Effect.service(ClaudeInstallation.ClaudeInstallation).pipe(
    Effect.provide(context),
  );
  return { service, calls, directory, entered, killed };
});

it.layer(Layer.merge(NodeServices.layer, NodeCrypto.layer))("Claude npm installation", (it) => {
  it.effect.each(["success", "failure", "mismatch"] as const)(
    "verifies npm installation: %s",
    (mode) =>
      Effect.gen(function* () {
        const { service, calls, directory } = yield* harness(mode);
        yield* service.start({ PATH: "/instance/bin", HTTPS_PROXY: "http://proxy:8080" });
        const result = yield* service.changes.pipe(
          Stream.filter((state) => state.phase === "succeeded" || state.phase === "failed"),
          Stream.runHead,
        );
        expect(result).toMatchObject({
          value: { phase: mode === "success" ? "succeeded" : "failed" },
        });
        expect(calls[1]?.args).toEqual([
          "install",
          "-g",
          "--prefix",
          `${directory}/tools/claude`,
          "--allow-scripts=@anthropic-ai/claude-code",
          "@anthropic-ai/claude-code@2.1.314",
        ]);
        expect(calls[1]?.env?.HTTPS_PROXY).toBe("http://proxy:8080");
        if (mode === "success") {
          const rejected = yield* service
            .remove([`${directory}/tools/claude/bin/claude`])
            .pipe(Effect.flip);
          expect(rejected.operation).toBe("remove-install");
          yield* service.remove();
          expect((yield* service.state).installedVersion).toBeNull();
        }
      }).pipe(Effect.scoped),
  );

  it.effect("shares a running installation and cancels its subprocess", () =>
    Effect.gen(function* () {
      const { service, entered, killed, calls } = yield* harness("blocked");
      const first = yield* service.start({});
      yield* Deferred.await(entered);
      const second = yield* service.start({});
      expect(second.operationId).toBe(first.operationId);
      expect(calls).toHaveLength(2);
      const state = yield* service.cancel(first.operationId!);
      yield* Deferred.await(killed);
      expect(state.phase).toBe("cancelled");
    }).pipe(Effect.scoped),
  );
});

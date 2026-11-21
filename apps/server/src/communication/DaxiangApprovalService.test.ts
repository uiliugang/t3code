import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as Executor from "./DaxiangApprovalExecutor.ts";
import * as Approval from "./DaxiangApprovalService.ts";
import * as Messages from "./DaxiangMessageService.ts";

it.effect("uses current approval settings for every link in a message", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "daxiang-settings-change-" });
      yield* fs.writeFileString(`${baseDir}/dumbo-web`, "#!/bin/sh\n", { mode: 0o755 });
      const settings = yield* ServerSettings.ServerSettingsService.pipe(
        Effect.provide(
          ServerSettings.ServerSettingsService.layerTest({
            meituanIntegrationEnabled: true,
            daxiang: {
              approvalMonitor: {
                enabled: true,
                autoApprovePullRequest: true,
                notifyUnsupportedLinks: false,
              },
            },
          }),
        ),
      );
      const approved: string[] = [];
      const event = JSON.stringify({
        event: "message",
        msgId: "message-1",
        sessionType: "chat",
        sessionId: "chat-1",
        fromUid: "sender",
        text: "https://dev.sankuai.com/code/repo-detail/group/repo/pr/1/diff https://dev.sankuai.com/code/repo-detail/group/repo/pr/2/diff",
      });
      const context = yield* Layer.build(Approval.layer).pipe(
        Effect.provideService(ServerSettings.ServerSettingsService, settings),
        Effect.provideService(Executor.DaxiangApprovalExecutor, {
          execute: (target) =>
            Effect.gen(function* () {
              approved.push(target.key);
              yield* settings
                .updateSettings({
                  daxiang: { approvalMonitor: { autoApprovePullRequest: false } },
                })
                .pipe(Effect.orDie);
              return { key: target.key, outcome: "approved" as const, detail: null };
            }),
        }),
        Effect.provideService(Messages.DaxiangMessageService, {
          sendLink: () => Effect.die("Unexpected message send"),
        }),
        Effect.provideService(ExternalLauncher.ExternalLauncher, {
          resolveAvailableEditors: () => Effect.succeed([]),
          resolveFileManagerRevealKind: () => Effect.undefined,
          launchBrowser: () => Effect.die("Unexpected browser launch"),
          launchEditor: () => Effect.die("Unexpected editor launch"),
        }),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.succeed({
              stdout: JSON.stringify({ loggedIn: true, uid: "owner" }),
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
        }),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(123),
                stdout: Stream.make(new TextEncoder().encode(`${event}\n`)),
                stderr: Stream.empty,
                all: Stream.empty,
                exitCode: Effect.never,
                isRunning: Effect.succeed(true),
                kill: () => Effect.void,
                stdin: Sink.drain,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void),
              }),
            ),
          ),
        ),
        Effect.provideService(HostProcess.Environment, { PATH: baseDir }),
        Effect.provide(ServerConfig.ServerConfig.layerTest(baseDir, baseDir)),
      );
      const service = Context.get(context, Approval.DaxiangApprovalService);
      yield* service.start;
      const snapshot = yield* service.subscribe.pipe(
        Stream.filter(
          (state) =>
            state.records.length === 2 ||
            state.status === "error" ||
            state.status === "missing_cli" ||
            state.status === "unauthenticated",
        ),
        Stream.runHead,
      );
      assert.deepStrictEqual(approved, ["pr:group/repo#1"]);
      assert.strictEqual(snapshot._tag, "Some");
      if (snapshot._tag === "Some") {
        assert.deepStrictEqual(
          snapshot.value.records.map((record) => record.outcome),
          ["skipped", "approved"],
        );
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

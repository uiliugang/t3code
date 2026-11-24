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
import * as ServerBrowser from "../preview/ServerBrowser.ts";

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
                autoApproveMcm: true,
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
        text: "https://kms.mws.sankuai.com/workflow?uid=42 https://dev.sankuai.com/code/repo-detail/group/repo/pr/1/diff https://dev.sankuai.com/code/repo-detail/group/repo/pr/2/diff",
      });
      const context = yield* Layer.build(Approval.layer).pipe(
        Effect.provide(Layer.mock(ServerBrowser.ServerBrowser)({})),
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
              stdout: JSON.stringify({ uid: "owner", fields: { u: true } }),
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
      const snapshot = yield* service.subscribe(true).pipe(
        Stream.filter(
          (state) =>
            state.records.some((record) => record.title === "group/repo #2") ||
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
          ["skipped", "approved", "skipped"],
        );
        assert.include(snapshot.value.records[2], {
          kind: "kms",
          title: "KMS #42",
          url: "https://kms.mws.sankuai.com/workflow?uid=42",
          outcome: "skipped",
        });
        const legacy = yield* service.subscribe().pipe(Stream.runHead);
        assert.deepStrictEqual(
          legacy._tag === "Some" ? legacy.value.records.map((record) => record.kind) : [],
          ["pr", "pr"],
        );
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { version: "v20.9.0", npm: true, nodeOptions: "--no-warnings", canImport: false },
  { version: "v20.10.0", npm: true, nodeOptions: "--no-warnings --experimental-websocket" },
  { version: "v20.10.0", npm: false, nodeOptions: "--no-warnings --experimental-websocket" },
  { version: "v22.0.0", npm: true, nodeOptions: "--no-warnings" },
])(
  "preserves status and sign-in on Node $version (npm: $npm)",
  ({ version, npm, nodeOptions, canImport }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "daxiang-browser-login-" });
      for (const executable of ["node", "dumbo-web.mjs"]) {
        yield* fs.writeFileString(`${baseDir}/${executable}`, "#!/usr/bin/env node\n", {
          mode: 0o755,
        });
      }
      if (npm) yield* fs.symlink("dumbo-web.mjs", `${baseDir}/npm`);
      yield* fs.symlink("dumbo-web.mjs", `${baseDir}/dumbo-web`);
      const tab = { threadId: "private-browser:login", tabId: "tab", port: 49152 };
      let opens = 0;
      let closes = 0;
      let signedIn = false;
      const ports: string[] = [];
      const context = yield* Layer.build(Approval.layer).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ServerBrowser.ServerBrowser)({
              openPrivateTab: () =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    opens += 1;
                    return tab;
                  }),
                  () =>
                    Effect.sync(() => {
                      closes += 1;
                    }),
                ),
            }),
            Layer.mock(Executor.DaxiangApprovalExecutor)({}),
            Layer.mock(Messages.DaxiangMessageService)({}),
            Layer.mock(ExternalLauncher.ExternalLauncher)({}),
            ServerSettings.ServerSettingsService.layerTest({
              meituanIntegrationEnabled: true,
              daxiang: { approvalMonitor: { enabled: true } },
            }),
            ServerConfig.ServerConfig.layerTest(baseDir, baseDir),
          ),
        ),
        Effect.provideService(HostProcess.Environment, {
          PATH: baseDir,
          NVM_DIR: baseDir,
          NODE_OPTIONS: "--no-warnings",
        }),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: ({ args = [], env }) =>
            Effect.sync(() => {
              const port = args.at(-1);
              if (args.includes("login") && port !== undefined) ports.push(port);
              const error = args.includes("--version")
                ? ""
                : env?.NODE_OPTIONS !== nodeOptions
                  ? "Invalid Node.js startup options"
                  : args.includes("login") && !signedIn
                    ? "not logged in"
                    : "";
              return {
                stdout: args.includes("--version") ? version : '{"loggedIn":false}',
                stderr: error,
                code: ChildProcessSpawner.ExitCode(error ? 1 : 0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
        }),
      );
      const service = Context.get(context, Approval.DaxiangApprovalService);
      yield* service.mutate({ type: "refresh" }, "owner");
      const status = yield* service.subscribe().pipe(Stream.runHead);
      assert.strictEqual(status._tag === "Some" && status.value.status, "unauthenticated");
      const open = (sessionId = "owner") =>
        service.mutate({ type: "open_browser_login" }, sessionId);
      const first = yield* open();
      const second = yield* open();
      assert.deepStrictEqual(first, { threadId: tab.threadId, tabId: tab.tabId });
      assert.deepStrictEqual(first, second);
      assert.strictEqual(opens, 1);

      yield* Effect.flip(open("other"));
      const finish = (threadId: string, sessionId = "owner") =>
        service.mutate({ type: "finish_browser_login", threadId }, sessionId);
      yield* Effect.flip(finish("private-browser:wrong"));
      yield* Effect.flip(finish(tab.threadId, "other"));
      assert.deepStrictEqual(ports, []);
      yield* Effect.flip(finish(tab.threadId));
      assert.strictEqual(closes, 0);
      if (canImport !== false) {
        signedIn = true;
        yield* finish(tab.threadId);
        assert.strictEqual(closes, 1);
        assert.deepStrictEqual(ports, ["49152", "49152"]);
      }

      yield* open();
      yield* service.mutate({ type: "cancel_browser_login", threadId: tab.threadId }, "owner");
      assert.strictEqual(closes, canImport === false ? 1 : 2);
    }).pipe(Effect.provide(NodeServices.layer)),
);

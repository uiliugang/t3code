import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type ServerConfig as ClientConfig,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as Executor from "./DaxiangApprovalExecutor.ts";
import * as Approval from "./DaxiangApprovalService.ts";
import * as Messages from "./DaxiangMessageService.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  RelayConnectionTarget,
} from "../../../../packages/client-runtime/src/connection/model.ts";
import { EnvironmentSupervisor } from "../../../../packages/client-runtime/src/connection/supervisor.ts";
import {
  subscribe,
  subscribeDaxiangApproval,
} from "../../../../packages/client-runtime/src/rpc/client.ts";
import type { RpcSession } from "../../../../packages/client-runtime/src/rpc/session.ts";

const approvalClients = Effect.fn("TestApproval.clients")(function* (
  service: Approval.DaxiangApprovalService["Service"],
) {
  const tag = WS_METHODS.daxiangApprovalSubscribe;
  const rpc = WsRpcGroup.requests.get(tag);
  if (rpc?._tag !== tag) throw new Error("Missing DaXiang approval RPC");
  const codec = Schema.toCodecJson(rpc.payloadSchema);
  const client = {
    [tag]: (request: typeof codec.Type) =>
      service.subscribe(Schema.decodeSync(codec)(Schema.encodeSync(codec)(request)).includeKms),
  };
  const session = yield* SubscriptionRef.make<Option.Option<RpcSession>>(
    Option.some({
      client: client as unknown as RpcSession["client"],
      initialConfig: Effect.succeed({
        environment: { capabilities: { daxiangApprovalMonitor: true } },
      } as ClientConfig),
      subscribeServerConfig: () => Stream.die("Unexpected config subscription"),
      ready: Effect.void,
      probe: Effect.void,
      inboundFrames: Effect.succeed(0),
      closed: Effect.never,
    }),
  );
  const supervisor = Layer.mock(EnvironmentSupervisor)({
    session,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    target: new RelayConnectionTarget({
      environmentId: EnvironmentId.make("offline"),
      label: "Offline",
    }),
  });
  return {
    current: subscribeDaxiangApproval({}).pipe(Stream.provide(supervisor)),
    legacy: subscribe(tag, {}).pipe(Stream.provide(supervisor)),
    optedOut: subscribeDaxiangApproval({ includeKms: false }).pipe(Stream.provide(supervisor)),
  };
});

it.effect.each(["unsupported launcher", "broken patched copy"])(
  "applies current approval settings and sends KMS cards only to opted-in clients after falling back from %s",
  (failure) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "daxiang-settings-change-" });
        const launcher = `${baseDir}/dumbo-web`;
        let entry: string | undefined;
        if (failure === "broken patched copy") {
          const cli = `${baseDir}/package/dumbo-web`;
          yield* fs.makeDirectory(`${cli}/bin`, { recursive: true });
          yield* fs.makeDirectory(`${cli}/lib`);
          yield* fs.writeFileString(
            `${baseDir}/package/package.json`,
            '{"name":"@sailor/dumbo-cdp","version":"0.6.6"}',
          );
          yield* fs.writeFileString(
            `${cli}/lib/service.mjs`,
            `export function normalizeMessage(message, ownUid) {
  return {
    body: message.body ?? null,
  };
}`,
          );
          yield* fs.writeFileString(`${cli}/bin/dumbo-web.mjs`, "#!/usr/bin/env node\n", {
            mode: 0o755,
          });
          yield* fs.symlink(`${cli}/bin/dumbo-web.mjs`, launcher);
          entry = yield* fs.realPath(launcher);
          yield* fs.writeFileString(`${baseDir}/node`, "#!/bin/sh\n", { mode: 0o755 });
          yield* fs.symlink(`${cli}/bin/dumbo-web.mjs`, `${baseDir}/npm`);
        } else {
          yield* fs.writeFileString(launcher, "#!/bin/sh\n", { mode: 0o755 });
        }
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
                  autoOpenUnsupportedInBrowser: true,
                },
              },
            }),
          ),
        );
        const approved: string[] = [];
        const opened: string[] = [];
        const watchArgs: ReadonlyArray<string>[] = [];
        const kmsUrl = "https://kms.mws.sankuai.com/key-management/workflow?uid=42";
        const envelope = {
          event: "message",
          sessionType: "chat",
          sessionId: "chat-1",
          fromUid: "sender",
        };
        const cards = [
          { ...envelope, msgId: "kms-card", body: { link: kmsUrl, content: kmsUrl } },
          {
            ...envelope,
            msgId: "pr-card",
            body: {
              content:
                "https://dev.sankuai.com/code/repo-detail/group/repo/pr/1/diff https://dev.sankuai.com/code/repo-detail/group/repo/pr/2/diff",
            },
          },
        ];
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
            launchBrowser: (url) =>
              Effect.sync(() => {
                opened.push(url);
              }),
            launchEditor: () => Effect.die("Unexpected editor launch"),
          }),
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: ({ args = [] }) => {
              const version = args.at(-1) === "--version";
              const patched = version && args.length > 1 && args[0] !== entry;
              return Effect.succeed({
                stdout: version ? "v22.0.0" : JSON.stringify({ uid: "owner", fields: { u: true } }),
                stderr: patched ? "Cannot load the patched CLI" : "",
                code: ChildProcessSpawner.ExitCode(patched ? 1 : 0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              });
            },
          }),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              if (command._tag !== "StandardCommand") return Effect.die("Unexpected pipeline");
              return Effect.sync(() => {
                watchArgs.push(command.args.map(String));
                return ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(123),
                  stdout: Stream.fromIterable(cards).pipe(
                    Stream.map((card) => new TextEncoder().encode(`${JSON.stringify(card)}\n`)),
                  ),
                  stderr: Stream.empty,
                  all: Stream.empty,
                  exitCode: Effect.never,
                  isRunning: Effect.succeed(true),
                  kill: () => Effect.void,
                  stdin: Sink.drain,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                  unref: Effect.succeed(Effect.void),
                });
              });
            }),
          ),
          Effect.provideService(HostProcess.Environment, { PATH: baseDir, NVM_DIR: baseDir }),
          Effect.provide(ServerConfig.ServerConfig.layerTest(baseDir, baseDir)),
        );
        const service = Context.get(context, Approval.DaxiangApprovalService);
        yield* service.start;
        const clients = yield* approvalClients(service);
        const snapshot = yield* clients.current.pipe(
          Stream.filter(
            (state) =>
              state.records.some((record) => record.title === "group/repo #2") ||
              state.status === "error" ||
              state.status === "missing_cli" ||
              state.status === "unauthenticated",
          ),
          Stream.runHead,
        );
        assert.deepStrictEqual(watchArgs, [entry ? [entry, "watch"] : ["watch"]]);
        assert.deepStrictEqual(approved, ["pr:group/repo#1"]);
        assert.deepStrictEqual(opened, [
          kmsUrl,
          "https://dev.sankuai.com/code/repo-detail/group/repo/pr/2/diff",
        ]);
        assert.strictEqual(snapshot._tag, "Some");
        if (snapshot._tag === "Some") {
          assert.isTrue(snapshot.value.enhancementFailed);
          assert.deepStrictEqual(
            snapshot.value.records.map((record) => record.outcome),
            ["opened", "approved", "opened"],
          );
          assert.include(snapshot.value.records[2], {
            kind: "kms",
            title: "KMS #42",
            url: kmsUrl,
            outcome: "opened",
          });
          for (const ordinaryOnly of [clients.legacy, clients.optedOut]) {
            const state = yield* ordinaryOnly.pipe(Stream.runHead);
            assert.deepStrictEqual(
              Option.getOrThrow(state).records,
              snapshot.value.records.slice(0, 2),
            );
          }
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

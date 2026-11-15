import { ProviderInstanceId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as Protocol from "./nativeCliProtocol.ts";
import {
  explicitNativeModel,
  isNativeCliCredential,
  nativeCliArguments,
} from "./nativeCliLaunch.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const messages = {
  thread: "The linked T3 thread or its active run is unavailable. Reopen the terminal.",
  selection: "Choose a default model in T3 Code or pass --t3-instance <instance-id>.",
  instance:
    "The selected T3 provider is missing, disabled, or unavailable. Check Providers in T3 Code.",
  mismatch:
    "This command does not match the selected provider. Use codex for Codex or claude for Claude, or pass --t3-instance <instance-id>.",
  auth: "The selected provider is signed out. Reconnect it in T3 Code.",
  launch:
    "Could not prepare the selected provider. Check its installation and connection in T3 Code.",
} as const;
export class NativeCliError extends Schema.TaggedError<
  NativeCliError,
  { readonly brand: unique symbol }
>()("NativeCliError", {
  reason: Schema.Literals(["thread", "selection", "instance", "mismatch", "auth", "launch"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return messages[this.reason];
  }
}

export class NativeCli extends Context.Service<
  NativeCli,
  {
    readonly resolve: (
      input: typeof Protocol.Request.Type,
    ) => Effect.Effect<
      Extract<typeof Protocol.Response.Type, { ok: true }>,
      NativeCliError,
      Scope.Scope
    >;
  }
>()("t3/provider/NativeCli") {}

const make = Effect.gen(function* () {
  const hostEnvironment = yield* HostProcess.Environment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const resolve = Effect.fn("NativeCli.resolve")(function* (input: typeof Protocol.Request.Type) {
    let selection: ModelSelection | null = null;
    if (input.threadId && !input.instanceId) {
      const threadId = ThreadId.make(input.threadId);
      const thread = yield* projections
        .getThreadShell(threadId)
        .pipe(Effect.mapError((cause) => new NativeCliError({ reason: "thread", cause })));
      if (!thread) return yield* new NativeCliError({ reason: "thread" });
      selection = thread.modelSelection;
      if (thread.activeRunId) {
        const run = yield* projections
          .getRun(threadId, thread.activeRunId)
          .pipe(Effect.mapError((cause) => new NativeCliError({ reason: "thread", cause })));
        if (!run) return yield* new NativeCliError({ reason: "thread" });
        selection = run.modelSelection;
      }
    } else {
      selection = (yield* settings.getSettings.pipe(
        Effect.mapError((cause) => new NativeCliError({ reason: "selection", cause })),
      )).defaultModelSelection;
    }
    const instanceId = input.instanceId
      ? ProviderInstanceId.make(input.instanceId)
      : selection?.instanceId;
    if (!instanceId) return yield* new NativeCliError({ reason: "selection" });
    const instance = yield* registry.getInstance(instanceId);
    if (!instance?.enabled) return yield* new NativeCliError({ reason: "instance" });
    if (
      instance.driverKind !== (input.command === "codex" ? "codex" : "claudeAgent") ||
      !instance.resolveNativeCli
    )
      return yield* new NativeCliError({ reason: "mismatch" });
    const snapshot = yield* instance.snapshot.getSnapshot;
    if (snapshot.auth.status === "unauthenticated")
      return yield* new NativeCliError({ reason: "auth" });
    if (!selection || selection.instanceId !== instanceId) {
      const model = explicitNativeModel(input.command, input.args) ?? snapshot.models[0]?.slug;
      if (!model) return yield* new NativeCliError({ reason: "selection" });
      selection = { instanceId, model };
    }
    const launch = yield* instance.resolveNativeCli.pipe(
      Effect.mapError((cause) => new NativeCliError({ reason: "launch", cause })),
    );
    const environment: Record<string, string | null> = Object.fromEntries(
      Object.entries(launch.environment)
        .filter(
          ([key, value]) =>
            isNativeCliCredential(key) ||
            key === "HOME" ||
            key === "USERPROFILE" ||
            launch.environmentKeys?.includes(key) ||
            value !== hostEnvironment[key],
        )
        .map(([key, value]) => [key, value ?? null]),
    );
    const command = path.isAbsolute(launch.command)
      ? launch.command
      : yield* resolveCommandPath(launch.command, { env: launch.environment }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HostProcess.Platform, platform),
        );
    if (!command) return yield* new NativeCliError({ reason: "launch" });
    // A terminal may inherit another provider's credentials; absence must clear them too.
    for (const key of [
      "CODEX_HOME",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_ACCESS_TOKEN",
      "T3_CODEX_API_KEY",
      "T3_CODEX_BASE_URL",
      "CLAUDE_CONFIG_DIR",
      "CLAUDECODE",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ELECTRON_RUN_AS_NODE",
    ])
      if (!(key in environment)) environment[key] = null;
    if (!launch.environmentKeys?.includes("ELECTRON_RUN_AS_NODE"))
      environment.ELECTRON_RUN_AS_NODE = null;
    return {
      ok: true as const,
      command: path.resolve(command),
      args: nativeCliArguments(input.command, selection, input.args, launch.args),
      environment,
    };
  });
  return NativeCli.of({ resolve });
});
export const layer = Layer.effect(NativeCli, make);

import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  RunId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2Run,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Stream from "effect/Stream";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Registry from "./ProviderInstanceRegistry.ts";
import * as NativeCli from "./NativeCli.ts";

const selection = (id: string, model = "gpt-6.1-sol"): ModelSelection => ({
  instanceId: ProviderInstanceId.make(id),
  model,
});

function fixture() {
  const defaultModel = selection("byok");
  let thread: Pick<OrchestrationV2ThreadShell, "modelSelection" | "activeRunId"> | null = {
    modelSelection: selection("chatgpt"),
    activeRunId: null,
  };
  let run: Pick<OrchestrationV2Run, "modelSelection"> | undefined;
  const instances = new Map<string, ProviderInstance>();
  for (const [id, driver] of [
    ["byok", "codex"],
    ["chatgpt", "codex"],
    ["work", "claudeAgent"],
  ]) {
    const snapshot: ServerProvider = {
      ...buildServerProvider({
        presentation: { displayName: id! },
        enabled: true,
        checkedAt: "2026-01-01T00:00:00Z",
        models: [{ slug: "opus", name: "Opus", isCustom: false, capabilities: null }],
        probe: {
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
        },
      }),
      instanceId: ProviderInstanceId.make(id!),
      driver: ProviderDriverKind.make(driver!),
    };
    instances.set(id!, {
      instanceId: ProviderInstanceId.make(id!),
      driverKind: ProviderDriverKind.make(driver!),
      enabled: true,
      displayName: id,
      continuationIdentity: { driverKind: ProviderDriverKind.make(driver!), continuationKey: id! },
      orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
      snapshot: {
        getSnapshot: Effect.succeed(snapshot),
        refresh: Effect.succeed(snapshot),
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
        resolveMaintenance: () =>
          Effect.succeed({
            provider: ProviderDriverKind.make(driver!),
            packageName: null,
            update: null,
          }),
      },
      resolveNativeCli: Effect.succeed({
        command: `/native/${driver}`,
        args: [],
        environment: { CODEX_HOME: `/homes/${id}`, PATH: "/server/path" },
      }),
    });
  }
  const layer = NativeCli.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ServerSettings.layerTest({ defaultModelSelection: defaultModel }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () => Effect.sync(() => thread as OrchestrationV2ThreadShell | null),
          getRun: () => Effect.sync(() => run as OrchestrationV2Run | undefined),
        }),
        Layer.mock(Registry.ProviderInstanceRegistry)({
          getInstance: (id) => Effect.sync(() => instances.get(id)),
        }),
        Layer.succeed(HostProcess.Environment, { PATH: "/server/path" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return {
    layer,
    instances,
    setThread: (value: typeof thread) => {
      thread = value;
    },
    setRun: (value: typeof run) => {
      run = value;
    },
  };
}

it.effect(
  "reads current defaults and active run selection for each invocation without sharing conversations",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const cli = yield* NativeCli.NativeCli;
      const launch = yield* cli.resolve({ command: "codex", args: ["prompt with spaces"] });
      expect(launch.environment.CODEX_HOME).toBe("/homes/byok");
      expect(launch.environment.OPENAI_API_KEY).toBeNull();
      expect(launch.environment.PATH).toBeUndefined();
      const byok = f.instances.get("byok")!;
      f.instances.set("byok", {
        ...byok,
        resolveNativeCli: byok.resolveNativeCli!.pipe(
          Effect.map((value) => ({ ...value, environmentKeys: ["PATH"] })),
        ),
      });
      expect((yield* cli.resolve({ command: "codex", args: [] })).environment.PATH).toBe(
        "/server/path",
      );
      const path = yield* Path.Path;
      f.instances.set("byok", {
        ...byok,
        resolveNativeCli: Effect.succeed({
          command: path.basename(process.execPath),
          args: [],
          environment: { PATH: path.dirname(process.execPath), ELECTRON_RUN_AS_NODE: "1" },
        }),
      });
      const pinned = yield* cli.resolve({ command: "codex", args: [] });
      expect(pinned.command).toBe(process.execPath);
      expect(pinned.environment.ELECTRON_RUN_AS_NODE).toBeNull();
      f.instances.set("byok", byok);
      expect(launch.args).toEqual(["--model", "gpt-6.1-sol", "prompt with spaces"]);
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        defaultModelSelection: selection("chatgpt", "next-model"),
      });
      expect((yield* cli.resolve({ command: "codex", args: [] })).args).toEqual([
        "--model",
        "next-model",
      ]);
      const threadId = ThreadId.make("thread");
      f.setThread({ modelSelection: selection("byok"), activeRunId: RunId.make("run") });
      f.setRun({ modelSelection: selection("chatgpt", "running-model") });
      expect((yield* cli.resolve({ command: "codex", threadId, args: [] })).args).toEqual([
        "--model",
        "running-model",
      ]);
      f.setThread({ modelSelection: selection("byok"), activeRunId: null });
      const work = f.instances.get("work")!;
      f.instances.set("work", {
        ...work,
        snapshot: {
          ...work.snapshot,
          getSnapshot: work.snapshot.getSnapshot.pipe(
            Effect.map((snapshot) => ({ ...snapshot, models: [] })),
          ),
        },
      });
      expect(
        (yield* cli.resolve({ command: "codex", threadId, args: [] })).environment.CODEX_HOME,
      ).toBe("/homes/byok");
      expect(
        (yield* cli.resolve({
          command: "claude",
          threadId,
          instanceId: "work",
          args: ["--model", "sonnet"],
        })).args,
      ).toEqual(["--model", "sonnet"]);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);

it.effect(
  "never falls back from an invalid linked thread, missing run, unavailable instance or command mismatch",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const cli = yield* NativeCli.NativeCli;
      const reason = (input: Parameters<typeof cli.resolve>[0]) =>
        cli.resolve(input).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );
      expect(yield* reason({ command: "claude", args: [] })).toBe("mismatch");
      expect(yield* reason({ command: "codex", instanceId: "missing", args: [] })).toBe("instance");
      f.setThread(null);
      expect(yield* reason({ command: "codex", threadId: "deleted", args: [] })).toBe("thread");
      f.setThread({ modelSelection: selection("byok"), activeRunId: RunId.make("lost") });
      expect(yield* reason({ command: "codex", threadId: "thread", args: [] })).toBe("thread");
      const byok = f.instances.get("byok")!;
      f.instances.set("byok", { ...byok, enabled: false });
      expect(yield* reason({ command: "codex", args: [] })).toBe("instance");
      f.instances.set("byok", {
        ...byok,
        snapshot: {
          ...byok.snapshot,
          getSnapshot: Effect.succeed({ auth: { status: "unauthenticated" } } as ServerProvider),
        },
      });
      expect(yield* reason({ command: "codex", args: [] })).toBe("auth");
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);

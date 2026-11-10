import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as WorkspaceRepositoryResolver from "../workspace/WorkspaceRepositoryResolver.ts";
import { EventId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import {
  type ManagedPolicySummary,
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { acpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { workspaceFixture } from "./testkit/workspaceFixtures.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const grokInstanceId = ProviderInstanceId.make("grok");
const antigravityInstanceId = ProviderInstanceId.make("antigravity");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
  [antigravityInstanceId, ["approval-required", "auto-accept-edits", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    orchestrationAdapter: {
      getCapabilities: () =>
        Effect.succeed({
          workspace: { multipleRoots: instanceId === providerInstanceId, readOnlyRoots: false },
          runtimePolicy: { supportsReadOnly: instanceId === providerInstanceId },
        }),
    },
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as unknown as ProviderInstance;

const layerWithPolicy = (policy?: ManagedPolicySummary) =>
  RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(ServerSettings.layerTest({}, policy)),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeedSome({
            projectId,
            title: "Project",
            workspaceRoot: "/project-root",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            pinnedAt: null,
            archivedAt: null,
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
      }),
    ),
  );

const layerTest = layerWithPolicy();

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("keeps a task's bound directories when project defaults change", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const thread = makeThread({ now, worktreePath: null });
      const workspace = workspaceFixture({ projectId: thread.projectId });
      const bound = yield* policy.resolve({ thread: { ...thread, workspace }, modelSelection });
      assert.equal(bound.cwd, "/tasks/frontend");
      assert.deepEqual(bound.workspace, workspace);
      const unsupported = yield* policy
        .resolve({
          thread: { ...thread, workspace },
          modelSelection: { ...modelSelection, instanceId: grokInstanceId },
        })
        .pipe(Effect.flip);
      assert.equal(unsupported._tag, "RuntimePolicyResolveError");
      const legacy = yield* policy.resolve({
        thread: { ...thread, projectWorkspaceRoot: "/original-project" },
        modelSelection,
      });
      assert.equal(legacy.cwd, "/original-project");
      const pendingIsolation = {
        ...thread,
        lineage: { ...thread.lineage, isolatedWorkspace: true },
      };
      const unprepared = yield* policy
        .resolve({ thread: pendingIsolation, modelSelection })
        .pipe(Effect.flip);
      assert.equal(unprepared._tag, "RuntimePolicyResolveError");
      yield* policy.resolve({
        thread: pendingIsolation,
        modelSelection,
        preparingWorkspace: true,
      });
      const stillUnprepared = yield* policy
        .resolve({ thread: pendingIsolation, modelSelection })
        .pipe(Effect.flip);
      assert.equal(stillUnprepared._tag, "RuntimePolicyResolveError");
      const prepared = yield* policy.resolve({
        thread: { ...pendingIsolation, workspace },
        modelSelection,
      });
      assert.deepEqual(prepared.workspace, workspace);
      const sideChat = { ...thread, lineage: { ...thread.lineage, sideChat: true } };
      const readOnly = yield* policy.resolve({
        thread: { ...sideChat, workspace },
        modelSelection,
      });
      assert.deepEqual(readOnly.sandboxPolicy, { type: "readOnly" });
      assert.equal(readOnly.approvalPolicy, "never");
      const unsupportedSideChat = yield* policy
        .resolve({
          thread: sideChat,
          modelSelection: { ...modelSelection, instanceId: grokInstanceId },
        })
        .pipe(Effect.flip);
      assert.equal(unsupportedSideChat._tag, "RuntimePolicyResolveError");
    }),
  );
  it.effect("asks for Antigravity command approval when a stored Auto thread falls back", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolve = (runtimeMode: RuntimeMode) =>
        policy.resolve({
          thread: makeThread({ now, worktreePath: null, runtimeMode }),
          modelSelection: { instanceId: antigravityInstanceId, model: "test-model" },
        });
      const request = {
        sessionId: "session-1",
        toolCall: { toolCallId: "command-1", title: "Run command", kind: "execute" as const },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
      };
      const auto = yield* resolve("auto");
      assert.equal(auto.runtimeMode, "approval-required");
      assert.equal(acpPermissionDisposition(auto, request), "ask");
      assert.equal(acpPermissionDisposition(yield* resolve("auto-accept-edits"), request), "ask");
      assert.equal(acpPermissionDisposition(yield* resolve("full-access"), request), "allow");
    }),
  );
  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );
});

it.effect(
  "prevents a legacy task from entering a checkout claimed by an active multi-repository task",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const thread = makeThread({ now, worktreePath: null });
      const workspace = workspaceFixture({ projectId });
      const projection = ProjectionStore.emptyProjection({
        type: "thread.created",
        id: EventId.make("created"),
        threadId: ThreadId.make("other"),
        occurredAt: now,
        payload: { ...thread, id: ThreadId.make("other"), workspace },
      });
      const sharedLayer = layerTest.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getShellSnapshot: () =>
                Effect.succeed({
                  schemaVersion: 2,
                  snapshotSequence: 1,
                  threads: [
                    { ...ProjectionStore.threadShellFromProjection(projection), status: "running" },
                  ],
                  archivedThreads: [],
                }),
            }),
            Layer.mock(WorkspaceRepositoryResolver.WorkspaceRepositoryResolver)({
              inspect: () => Effect.succeed(workspace.resources[1]!.identity),
              verify: () => Effect.void,
            }),
          ),
        ),
      );
      const result = yield* RuntimePolicy.RuntimePolicyV2.use((policy) =>
        policy.resolve({ thread, modelSelection }),
      ).pipe(Effect.provide(sharedLayer), Effect.result);
      assert.isTrue(result._tag === "Failure");
      yield* RuntimePolicy.RuntimePolicyV2.use((policy) =>
        policy.resolve({
          thread: { ...thread, lineage: { ...thread.lineage, isolatedWorkspace: true } },
          modelSelection,
          preparingWorkspace: true,
        }),
      ).pipe(Effect.provide(sharedLayer));
      const sideChat = { ...thread, lineage: { ...thread.lineage, sideChat: true } };
      const readOnly = yield* RuntimePolicy.RuntimePolicyV2.use((policy) =>
        policy.resolve({ thread: sideChat, modelSelection }),
      ).pipe(Effect.provide(sharedLayer));
      assert.deepEqual(readOnly.sandboxPolicy, { type: "readOnly" });
      const boundReadOnly = yield* RuntimePolicy.RuntimePolicyV2.use((policy) =>
        policy.resolve({ thread: { ...sideChat, workspace }, modelSelection }),
      ).pipe(Effect.provide(sharedLayer));
      assert.equal(boundReadOnly.approvalPolicy, "never");
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.layer(
  layerWithPolicy({
    organization: "Example Corp",
    lockedSettings: [],
    limits: { maxRuntimeMode: "auto-accept-edits" },
  }),
)("RuntimePolicyV2 under a runtime mode ceiling", (it) => {
  it.effect("refuses to start a turn above the ceiling, such as one resumed after a restart", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolve = (runtimeMode: RuntimeMode) =>
        policy.resolve({
          thread: makeThread({ now, worktreePath: "/work", runtimeMode }),
          modelSelection,
        });

      const refused = yield* resolve("full-access").pipe(Effect.flip);
      assert.equal(refused._tag, "RuntimePolicyAboveCeilingError");
      assert.equal(
        refused.message,
        "Example Corp limits threads to Auto-accept edits. Switch this thread's mode to continue.",
      );
      const allowed = yield* resolve("auto-accept-edits");
      assert.equal(allowed.runtimeMode, "auto-accept-edits");
      assert.equal(allowed.maxRuntimeMode, "auto-accept-edits");
    }),
  );
});

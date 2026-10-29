import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as WorkspaceRepositoryResolver from "../workspace/WorkspaceRepositoryResolver.ts";
import { EventId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import {
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
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    orchestrationAdapter: {
      getCapabilities: () =>
        Effect.succeed({
          workspace: { multipleRoots: instanceId === providerInstanceId, readOnlyRoots: false },
        }),
    },
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as unknown as ProviderInstance;

const layerTest = RuntimePolicy.layerFromProjectStore.pipe(
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
          createdAt: "2026-06-21T00:00:00.000Z",
          updatedAt: "2026-06-21T00:00:00.000Z",
          deletedAt: null,
        }),
    }),
  ),
);

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
            }),
          ),
        ),
      );
      const result = yield* RuntimePolicy.RuntimePolicyV2.use((policy) =>
        policy.resolve({ thread, modelSelection }),
      ).pipe(Effect.provide(sharedLayer), Effect.result);
      assert.isTrue(result._tag === "Failure");
    }).pipe(Effect.provide(NodeServices.layer)),
);

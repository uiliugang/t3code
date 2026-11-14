import * as ProjectionStore from "./ProjectionStore.ts";
import * as WorkspaceRestore from "../workspace/WorkspaceRestore.ts";
import * as WorkspaceRepositoryResolver from "../workspace/WorkspaceRepositoryResolver.ts";
import {
  isRuntimeModeAbove,
  managedRuntimeModeCeilingMessage,
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { worktreeDependencyEnvironment } from "../workspace/worktreeDependencyEnvironment.ts";

export class RuntimePolicyResolveError extends Schema.TaggedError<
  RuntimePolicyResolveError,
  { readonly brand: unique symbol }
>()("RuntimePolicyResolveError", {
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    if (typeof this.cause === "string") return this.cause;
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

/**
 * A turn would start in a mode above the policy's ceiling. The orchestrator refuses those when
 * they are dispatched; this catches the ones it never saw, such as a run resumed after a restart
 * on a thread whose mode predates the policy.
 */
export class RuntimePolicyAboveCeilingError extends Schema.TaggedError<
  RuntimePolicyAboveCeilingError,
  { readonly brand: unique symbol }
>()("RuntimePolicyAboveCeilingError", {
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  maxRuntimeMode: RuntimeMode,
  organization: Schema.String,
}) {
  override get message(): string {
    return `${managedRuntimeModeCeilingMessage(this.organization, this.maxRuntimeMode)} Switch this thread's mode to continue.`;
  }
}

export const isRuntimePolicyAboveCeilingError = Schema.is(RuntimePolicyAboveCeilingError);

export const RuntimePolicyV2Error = Schema.Union([
  RuntimePolicyResolveError,
  RuntimePolicyAboveCeilingError,
]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
    /** Deferred dispatch validates policy before its isolated checkout is provisioned. */
    readonly preparingWorkspace?: boolean;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

const requireIsolatedWorkspace = (thread: OrchestrationV2AppThread) =>
  thread.lineage.isolatedWorkspace === true &&
  (thread.workspace === undefined
    ? thread.worktreePath === null
    : thread.workspace.mode !== "isolated")
    ? Effect.fail(
        new RuntimePolicyResolveError({
          projectId: thread.projectId,
          providerInstanceId: thread.modelSelection.instanceId,
          cause:
            "The isolated worktree is not ready. Wait for setup, or return to the side chat and create a new isolated task.",
        }),
      )
    : Effect.void;

export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (
    input: Parameters<RuntimePolicyV2Shape["resolve"]>[0],
  ) {
    if (!input.preparingWorkspace) yield* requireIsolatedWorkspace(input.thread);
    return {
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      ...(input.thread.lineage.sideChat === true
        ? { approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } }
        : {}),
      cwd:
        input.thread.workspace?.bindings.find(
          (binding) => binding.rootId === input.thread.workspace?.primaryRootId,
        )?.executionPath ??
        input.thread.worktreePath ??
        input.thread.projectWorkspaceRoot ??
        null,
      ...(input.thread.workspace === undefined ? {} : { workspace: input.thread.workspace }),
    };
  }),
});

function providerRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : "approval-required";
}

const refuseAboveCeiling = (
  managedPolicy: ServerSettings.ServerSettingsService["Service"]["managedPolicy"],
  thread: OrchestrationV2AppThread,
) => {
  const maxRuntimeMode = managedPolicy?.limits?.maxRuntimeMode;
  return managedPolicy !== undefined &&
    maxRuntimeMode !== undefined &&
    isRuntimeModeAbove(thread.runtimeMode, maxRuntimeMode)
    ? Effect.fail(
        new RuntimePolicyAboveCeilingError({
          threadId: thread.id,
          runtimeMode: thread.runtimeMode,
          maxRuntimeMode,
          organization: managedPolicy.organization,
        }),
      )
    : Effect.void;
};

/** Lays the policy's ceiling over another runtime policy, as `layerFromProjectStore` does. */
export const layerEnforcingCeiling: Layer.Layer<
  RuntimePolicyV2,
  never,
  RuntimePolicyV2 | ServerSettings.ServerSettingsService
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicyV2;
    const { managedPolicy } = yield* ServerSettings.ServerSettingsService;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolveWithinCeiling")(function* (input) {
        yield* refuseAboveCeiling(managedPolicy, input.thread);
        return yield* base.resolve(input);
      }),
    });
  }),
);

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  | ProjectStore.ProjectStoreV2
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ServerSettings.ServerSettingsService
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projections = yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2);
    const workspaceRestore = yield* Effect.serviceOption(WorkspaceRestore.WorkspaceRestore);
    const repositoryResolver = yield* Effect.serviceOption(
      WorkspaceRepositoryResolver.WorkspaceRepositoryResolver,
    );
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    // The same ceiling the orchestrator enforces, fixed for the server's life.
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const { managedPolicy } = serverSettings;
    const maxRuntimeMode = managedPolicy?.limits?.maxRuntimeMode;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        yield* refuseAboveCeiling(managedPolicy, input.thread);
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        if (!input.preparingWorkspace) yield* requireIsolatedWorkspace(input.thread);
        const sideChat = input.thread.lineage.sideChat === true;
        const capabilities =
          !sideChat || instance === undefined
            ? undefined
            : yield* instance.orchestrationAdapter.getCapabilities().pipe(
                Effect.mapError(
                  (cause) =>
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause,
                    }),
                ),
              );
        if (sideChat && capabilities?.runtimePolicy.supportsReadOnly !== true) {
          return yield* new RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
            cause:
              "This provider cannot enforce read-only side chats. Choose Codex or Claude, or start an isolated task.",
          });
        }
        const supportedRuntimeModes =
          instance === undefined
            ? undefined
            : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
        if (input.thread.workspace !== undefined) {
          const workspace = input.thread.workspace;
          if (!sideChat && !input.preparingWorkspace && Option.isSome(projections)) {
            const shell = yield* projections.value.getShellSnapshot().pipe(
              Effect.mapError(
                (cause) =>
                  new RuntimePolicyResolveError({
                    projectId: input.thread.projectId,
                    providerInstanceId: input.modelSelection.instanceId,
                    cause,
                  }),
              ),
            );
            const resourceIds = new Set(workspace.resources.map((resource) => resource.id));
            const checkoutRoots = new Set(
              workspace.resources.map((resource) => resource.checkoutRoot),
            );
            for (const thread of [...shell.threads, ...shell.archivedThreads]) {
              if (
                thread.id === input.thread.id ||
                thread.lineage.sideChat === true ||
                thread.deletedAt !== null ||
                (!["preparing", "starting", "running", "waiting"].includes(thread.status) &&
                  (thread.pendingBackgroundTasks?.length ?? 0) === 0)
              )
                continue;
              let shared =
                thread.workspace?.resources.some(
                  (resource) =>
                    resourceIds.has(resource.id) || checkoutRoots.has(resource.checkoutRoot),
                ) ?? false;
              const cwd =
                thread.worktreePath ??
                thread.projectWorkspaceRoot ??
                Option.getOrUndefined(
                  yield* projects.get(thread.projectId).pipe(
                    Effect.mapError(
                      (cause) =>
                        new RuntimePolicyResolveError({
                          projectId: input.thread.projectId,
                          providerInstanceId: input.modelSelection.instanceId,
                          cause,
                        }),
                    ),
                  ),
                )?.workspaceRoot;
              if (!thread.workspace && cwd && Option.isSome(repositoryResolver)) {
                const checkout = yield* repositoryResolver.value.inspect(cwd).pipe(Effect.option);
                shared =
                  Option.isSome(checkout) &&
                  workspace.resources.some(
                    (resource) => resource.identity.gitDir === checkout.value.gitDir,
                  );
              }
              if (shared)
                return yield* new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  cause:
                    "A repository is currently used by another task. Create an isolated worktree group or wait for that task to stop.",
                });
            }
          }
          if (Option.isSome(workspaceRestore))
            yield* workspaceRestore.value.assertReady(input.thread.id, workspace).pipe(
              Effect.mapError(
                (cause) =>
                  new RuntimePolicyResolveError({
                    projectId: input.thread.projectId,
                    providerInstanceId: input.modelSelection.instanceId,
                    cause,
                  }),
              ),
            );
          if (Option.isSome(repositoryResolver))
            yield* Effect.forEach(
              workspace.resources,
              (resource) => repositoryResolver.value.verify(resource.identity),
              { discard: true },
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new RuntimePolicyResolveError({
                    projectId: input.thread.projectId,
                    providerInstanceId: input.modelSelection.instanceId,
                    cause,
                  }),
              ),
            );
          const capabilities =
            workspace.bindings.length > 1 ||
            workspace.bindings.some((binding) => binding.accessIntent === "read_only")
              ? yield* instance === undefined
                  ? Effect.void
                  : instance.orchestrationAdapter.getCapabilities().pipe(
                      Effect.mapError(
                        (cause) =>
                          new RuntimePolicyResolveError({
                            projectId: input.thread.projectId,
                            providerInstanceId: input.modelSelection.instanceId,
                            cause,
                          }),
                      ),
                    )
              : undefined;
          if (
            (workspace.bindings.length > 1 && capabilities?.workspace?.multipleRoots !== true) ||
            workspace.bindings.some((binding) => binding.accessIntent === "read_only") ||
            !workspace.bindings.some((binding) => binding.rootId === workspace.primaryRootId)
          ) {
            return yield* new RuntimePolicyResolveError({
              projectId: input.thread.projectId,
              providerInstanceId: input.modelSelection.instanceId,
              cause: "The provider cannot enforce this workspace configuration.",
            });
          }
        }
        const cwd =
          input.thread.workspace?.bindings.find(
            (binding) => binding.rootId === input.thread.workspace?.primaryRootId,
          )?.executionPath ??
          input.thread.worktreePath ??
          input.thread.projectWorkspaceRoot ??
          (yield* projects.get(input.thread.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause: "Project not found.",
                    }),
                  ),
                onSome: (project) => Effect.succeed(project.workspaceRoot),
              }),
            ),
          ));
        if (
          input.thread.workspace === undefined &&
          !sideChat &&
          !input.preparingWorkspace &&
          Option.isSome(projections) &&
          Option.isSome(repositoryResolver)
        ) {
          const check = Effect.gen(function* () {
            const shell = yield* projections.value.getShellSnapshot();
            const configured = [...shell.threads, ...shell.archivedThreads].filter(
              (thread) =>
                thread.id !== input.thread.id &&
                thread.lineage.sideChat !== true &&
                thread.deletedAt === null &&
                thread.workspace !== undefined,
            );
            if (configured.length === 0) return;
            const identity = yield* repositoryResolver.value.inspect(cwd).pipe(Effect.option);
            if (Option.isNone(identity)) return;
            for (const thread of configured) {
              if (
                !thread.workspace!.resources.some(
                  (resource) => resource.identity.gitDir === identity.value.gitDir,
                )
              )
                continue;
              if (
                ["preparing", "starting", "running", "waiting"].includes(thread.status) ||
                (thread.pendingBackgroundTasks?.length ?? 0) > 0
              )
                return yield* Effect.fail(
                  "This repository is in use by another workspace. Wait for that task or use an isolated worktree.",
                );
              if (Option.isSome(workspaceRestore))
                yield* workspaceRestore.value.assertReady(thread.id, thread.workspace);
            }
          });
          yield* check.pipe(
            Effect.mapError(
              (cause) =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  cause,
                }),
            ),
          );
        }
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: providerRuntimeMode(input.thread.runtimeMode, supportedRuntimeModes),
          interactionMode: input.thread.interactionMode,
          ...(sideChat ? { approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } } : {}),
          cwd,
          ...(input.thread.workspace === undefined ? {} : { workspace: input.thread.workspace }),
          ...(input.thread.workspace?.mode === "isolated" ||
          (input.thread.workspace === undefined && input.thread.worktreePath !== null)
            ? {
                environment: worktreeDependencyEnvironment(
                  yield* serverSettings.getSettings.pipe(
                    Effect.mapError(
                      (cause) =>
                        new RuntimePolicyResolveError({
                          projectId: input.thread.projectId,
                          providerInstanceId: input.modelSelection.instanceId,
                          cause,
                        }),
                    ),
                  ),
                  input.thread.projectId,
                ),
              }
            : {}),
          ...(maxRuntimeMode === undefined ? {} : { maxRuntimeMode }),
        });
      }),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.map((policy) =>
              ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                ...policy,
                ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                ...(override.approvalPolicy === undefined
                  ? {}
                  : { approvalPolicy: override.approvalPolicy }),
                ...(override.sandboxPolicy === undefined
                  ? {}
                  : { sandboxPolicy: override.sandboxPolicy }),
                ...(override.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: override.reasoningEffort }),
              }),
            ),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}

import * as ProjectionStore from "./ProjectionStore.ts";
import * as WorkspaceRestore from "../workspace/WorkspaceRestore.ts";
import * as WorkspaceRepositoryResolver from "../workspace/WorkspaceRepositoryResolver.ts";
import {
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectStore from "./ProjectStore.ts";

export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (typeof this.cause === "string") return this.cause;
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

export const RuntimePolicyV2Error = Schema.Union([RuntimePolicyResolveError]);
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
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: Effect.fn("RuntimePolicyV2.resolve")(function (
    input: Parameters<RuntimePolicyV2Shape["resolve"]>[0],
  ) {
    return Effect.succeed({
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      cwd:
        input.thread.workspace?.bindings.find(
          (binding) => binding.rootId === input.thread.workspace?.primaryRootId,
        )?.executionPath ??
        input.thread.worktreePath ??
        input.thread.projectWorkspaceRoot ??
        null,
      ...(input.thread.workspace === undefined ? {} : { workspace: input.thread.workspace }),
    });
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

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  ProjectStore.ProjectStoreV2 | ProviderInstanceRegistry.ProviderInstanceRegistry
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
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        const supportedRuntimeModes =
          instance === undefined
            ? undefined
            : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
        if (input.thread.workspace !== undefined) {
          const workspace = input.thread.workspace;
          if (Option.isSome(projections)) {
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
            for (const thread of [...shell.threads, ...shell.archivedThreads]) {
              if (
                thread.id === input.thread.id ||
                thread.deletedAt !== null ||
                (!["preparing", "starting", "running", "waiting"].includes(thread.status) &&
                  (thread.pendingBackgroundTasks?.length ?? 0) === 0)
              )
                continue;
              let shared =
                thread.workspace?.resources.some((resource) => resourceIds.has(resource.id)) ??
                false;
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
          Option.isSome(projections) &&
          Option.isSome(repositoryResolver)
        ) {
          const check = Effect.gen(function* () {
            const shell = yield* projections.value.getShellSnapshot();
            const configured = [...shell.threads, ...shell.archivedThreads].filter(
              (thread) =>
                thread.id !== input.thread.id &&
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
          cwd,
          ...(input.thread.workspace === undefined ? {} : { workspace: input.thread.workspace }),
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

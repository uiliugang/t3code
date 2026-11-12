import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ExecutionResourceId, ThreadId, WorkspaceRevisionId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { emptyProjection, threadShellFromProjection } from "../orchestration-v2/ProjectionStore.ts";
import {
  workspaceFixture,
  workspaceThreadFixture,
} from "../orchestration-v2/testkit/workspaceFixtures.ts";
import * as WorkspaceRepositoryResolver from "./WorkspaceRepositoryResolver.ts";
import * as WorkspaceAccess from "./WorkspaceAccess.ts";

it.effect(
  "rejects unscoped and stale writes and resolves the selected secondary checkout without falling back to primary",
  () =>
    Effect.gen(function* () {
      const workspace = workspaceFixture();
      const thread = workspaceThreadFixture(workspace);
      const projection = emptyProjection({
        type: "thread.created",
        id: EventId.make("created"),
        threadId: thread.id,
        occurredAt: thread.createdAt,
        payload: thread,
      });
      const writes = yield* Ref.make(0);
      const dependencies = Layer.mergeAll(
        Layer.succeed(
          FileSystem.FileSystem,
          FileSystem.makeNoop({ realPath: (value) => Effect.succeed(value) }),
        ),
        Layer.mock(WorkspaceRepositoryResolver.WorkspaceRepositoryResolver)({
          inspect: () => Effect.succeed(workspace.resources[1]!.identity),
          verify: () => Effect.void,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(projection),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 1,
              threads: [threadShellFromProjection(projection)],
              archivedThreads: [],
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const access = yield* WorkspaceAccess.WorkspaceAccess;
        const resource = workspace.resources[1]!;
        const target = {
          threadId: thread.id,
          workspaceRevisionId: workspace.id,
          resourceId: resource.id,
        };
        const write = Ref.update(writes, (value) => value + 1);
        assert.equal(
          yield* access.run({ cwd: resource.checkoutRoot }, Effect.succeed("prepared"), false),
          "prepared",
        );
        yield* access.run({ cwd: resource.checkoutRoot }, write).pipe(Effect.flip);
        yield* access.run({ cwd: `${resource.checkoutRoot}/src` }, write).pipe(Effect.flip);
        yield* access
          .run({ cwd: workspace.resources[0]!.checkoutRoot, repositoryTarget: target }, write)
          .pipe(Effect.flip);
        for (const writeAccess of [true, false]) {
          yield* access
            .run(
              {
                cwd: resource.checkoutRoot,
                repositoryTarget: {
                  ...target,
                  workspaceRevisionId: WorkspaceRevisionId.make("stale"),
                },
              },
              write,
              writeAccess,
            )
            .pipe(Effect.flip);
        }
        assert.equal(yield* Ref.get(writes), 0);
        yield* access.run({ cwd: resource.checkoutRoot, repositoryTarget: target }, write);
        assert.equal(yield* Ref.get(writes), 1);
      }).pipe(Effect.provide(WorkspaceAccess.layer.pipe(Layer.provide(dependencies))));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("serializes writes to one checkout across persisted resource IDs and path aliases", () =>
  Effect.gen(function* () {
    const workspace = workspaceFixture();
    const resource = workspace.resources[0]!;
    const oldThread = workspaceThreadFixture(workspace);
    const newThread = {
      ...oldThread,
      id: ThreadId.make("after-remount"),
      workspace: {
        ...workspace,
        bindings: workspace.bindings.map((binding) => ({
          ...binding,
          resourceId: ExecutionResourceId.make(`${binding.resourceId}:after-remount`),
        })),
        resources: workspace.resources.map((entry) => ({
          ...entry,
          id: ExecutionResourceId.make(`${entry.id}:after-remount`),
          identity: { ...entry.identity, gitDirIdentity: "after-remount" },
        })),
      },
    };
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const validated = yield* Deferred.make<void>();
    const order = yield* Ref.make<string[]>([]);
    const dependencies = Layer.mergeAll(
      Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({ realPath: () => Effect.succeed(resource.checkoutRoot) }),
      ),
      Layer.mock(WorkspaceRepositoryResolver.WorkspaceRepositoryResolver)({
        verify: (identity) =>
          identity.gitDirIdentity === "after-remount"
            ? Deferred.succeed(validated, undefined).pipe(Effect.asVoid)
            : Effect.void,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadRecords: (id) =>
          Effect.succeed(
            emptyProjection({
              type: "thread.created",
              id: EventId.make(`created:${id}`),
              threadId: id,
              occurredAt: oldThread.createdAt,
              payload: id === oldThread.id ? oldThread : newThread,
            }),
          ),
      }),
    );
    yield* Effect.gen(function* () {
      const access = yield* WorkspaceAccess.WorkspaceAccess;
      const input = (thread: typeof oldThread, resourceId: ExecutionResourceId, cwd: string) => ({
        cwd,
        repositoryTarget: { threadId: thread.id, workspaceRevisionId: workspace.id, resourceId },
      });
      const first = yield* access
        .run(
          input(oldThread, resource.id, resource.checkoutRoot),
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            yield* Ref.update(order, (values) => [...values, "old"]);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const second = yield* access
        .run(
          input(newThread, newThread.workspace.resources[0]!.id, "/alias"),
          Ref.update(order, (values) => [...values, "new"]),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(validated);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.deepEqual(yield* Ref.get(order), ["old", "new"]);
    }).pipe(Effect.provide(WorkspaceAccess.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

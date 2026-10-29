import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, WorkspaceRevisionId } from "@t3tools/contracts";
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
        yield* access.run({ cwd: resource.checkoutRoot }, write).pipe(Effect.flip);
        yield* access.run({ cwd: `${resource.checkoutRoot}/src` }, write).pipe(Effect.flip);
        yield* access
          .run({ cwd: workspace.resources[0]!.checkoutRoot, repositoryTarget: target }, write)
          .pipe(Effect.flip);
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
          )
          .pipe(Effect.flip);
        assert.equal(yield* Ref.get(writes), 0);
        yield* access.run({ cwd: resource.checkoutRoot, repositoryTarget: target }, write);
        assert.equal(yield* Ref.get(writes), 1);
      }).pipe(Effect.provide(WorkspaceAccess.layer.pipe(Layer.provide(dependencies))));
    }).pipe(Effect.provide(NodeServices.layer)),
);

import * as TerminalManager from "../terminal/Manager.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  ThreadId,
  VcsUnsupportedOperationError,
  type OrchestrationV2Checkpoint,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { workspaceFixture } from "../orchestration-v2/testkit/workspaceFixtures.ts";
import * as WorkspaceRepositoryResolver from "./WorkspaceRepositoryResolver.ts";
import * as WorkspaceRestore from "./WorkspaceRestore.ts";

it.effect(
  "compensates every repository on file failure and freezes an uncertain provider rewind",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "workspace-index-test-" });
      const source = workspaceFixture();
      const workspace = {
        ...source,
        resources: source.resources.map((resource, index) => ({
          ...resource,
          identity: { ...resource.identity, gitDir: path.join(temp, String(index)) },
        })),
      };
      for (const resource of workspace.resources) {
        yield* fs.makeDirectory(resource.identity.gitDir);
        yield* fs.writeFileString(path.join(resource.identity.gitDir, "index"), "original staging");
      }
      const contents = new Map(
        workspace.resources.map((resource) => [resource.checkoutRoot, "before restore"]),
      );
      const snapshots = new Map<string, string>();
      const failFiles = yield* Ref.make(true);
      const terminalOpen = yield* Ref.make(true);
      const target = CheckpointRef.make("refs/test/target");
      for (const resource of workspace.resources)
        snapshots.set(`${resource.checkoutRoot}:${target}`, "checkpoint contents");
      const checkpoint: OrchestrationV2Checkpoint = {
        id: CheckpointId.make("checkpoint"),
        threadId: ThreadId.make("thread"),
        scopeId: CheckpointScopeId.make("scope"),
        runId: null,
        nodeId: NodeId.make("node"),
        parentCheckpointId: null,
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        ref: target,
        status: "ready",
        files: [],
        capturedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
        resources: workspace.resources.map((resource, index) => ({
          resourceId: resource.id,
          scopeId: CheckpointScopeId.make(`scope:${index}`),
          checkpointId: CheckpointId.make(`checkpoint:${index}`),
          ref: target,
          status: "ready",
          files: [],
        })),
      };
      const layer = WorkspaceRestore.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(TerminalManager.TerminalManager)({
              subscribeMetadata: (listener) =>
                Ref.get(terminalOpen).pipe(
                  Effect.flatMap((open) =>
                    listener({
                      type: "snapshot",
                      terminals: open
                        ? [
                            {
                              threadId: "different-thread",
                              terminalId: "terminal",
                              cwd: workspace.resources[1]!.checkoutRoot,
                              worktreePath: workspace.resources[1]!.checkoutRoot,
                              status: "running",
                              pid: 123,
                              exitCode: null,
                              exitSignal: null,
                              hasRunningSubprocess: true,
                              label: "server",
                              updatedAt: "now",
                            },
                          ]
                        : [],
                    }),
                  ),
                  Effect.as(() => {}),
                ),
            }),
            Layer.mock(WorkspaceRepositoryResolver.WorkspaceRepositoryResolver)({
              verify: () => Effect.void,
            }),
            Layer.mock(CheckpointStore.CheckpointStore)({
              hasCheckpointRef: ({ cwd, checkpointRef }) =>
                Effect.succeed(snapshots.has(`${cwd}:${checkpointRef}`)),
              captureCheckpoint: ({ cwd, checkpointRef }) =>
                Effect.sync(() => {
                  snapshots.set(`${cwd}:${checkpointRef}`, contents.get(cwd)!);
                }),
              restoreCheckpoint: ({ cwd, checkpointRef }) =>
                Effect.gen(function* () {
                  if (
                    cwd === workspace.resources[1]!.checkoutRoot &&
                    checkpointRef === target &&
                    (yield* Ref.get(failFiles))
                  )
                    return yield* new VcsUnsupportedOperationError({
                      operation: "test restore",
                      kind: "git",
                      detail: "checkout failure",
                    });
                  const value = snapshots.get(`${cwd}:${checkpointRef}`);
                  if (value === undefined) return false;
                  contents.set(cwd, value);
                  const resource = workspace.resources.find(
                    (resource) => resource.checkoutRoot === cwd,
                  )!;
                  yield* fs
                    .writeFileString(
                      path.join(resource.identity.gitDir, "index"),
                      "restored staging",
                    )
                    .pipe(Effect.orDie);
                  return true;
                }),
            }),
          ),
        ),
        Layer.provide(Sqlite.layerMemory),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const restore = yield* WorkspaceRestore.WorkspaceRestore;
        const input = { threadId: checkpoint.threadId, workspace, checkpoint };
        const occupied = yield* restore.run(input, Effect.void).pipe(Effect.flip);
        assert.include(occupied.message, "terminals");
        assert.equal(snapshots.size, 2);
        yield* Ref.set(terminalOpen, false);
        const failedFiles = yield* restore
          .run(input, Effect.die("provider must not start after file failure"))
          .pipe(Effect.flip);
        assert.include(failedFiles.message, "pre-operation contents");
        assert.deepEqual([...contents.values()], ["before restore", "before restore"]);
        for (const resource of workspace.resources)
          assert.equal(
            yield* fs.readFileString(path.join(resource.identity.gitDir, "index")),
            "original staging",
          );
        yield* restore.assertReady(input.threadId);
        yield* Ref.set(failFiles, false);
        const failedProvider = yield* restore
          .run(input, Effect.fail("provider result unknown"))
          .pipe(Effect.flip);
        assert.include(failedProvider.message, "uncertain result");
        assert.deepEqual([...contents.values()], ["before restore", "before restore"]);
        assert.include(
          (yield* restore.assertReady(input.threadId).pipe(Effect.flip)).message,
          "recovery is required",
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

import * as TerminalManager from "../terminal/Manager.ts";
import * as Ref from "effect/Ref";
import { type TerminalSummary } from "@t3tools/contracts";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  CheckpointRef,
  ThreadId,
  ThreadWorkspaceRevision,
  type OrchestrationV2Checkpoint,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as WorkspaceRepositoryResolver from "./WorkspaceRepositoryResolver.ts";

export const RestoreJournal = Schema.Struct({
  workspace: ThreadWorkspaceRevision,
  recoveryWorkspace: Schema.optional(ThreadWorkspaceRevision),
  backups: Schema.Array(
    Schema.Struct({
      cwd: Schema.String,
      ref: CheckpointRef,
      indexPath: Schema.String,
      indexBackup: Schema.NullOr(Schema.String),
    }),
  ),
});
const json = Schema.fromJsonString(RestoreJournal);
type RestoreInput = {
  readonly threadId: ThreadId;
  readonly workspace: ThreadWorkspaceRevision;
  readonly checkpoint: OrchestrationV2Checkpoint;
};

export class WorkspaceRestoreError extends Schema.TaggedError<WorkspaceRestoreError>()(
  "WorkspaceRestoreError",
  { threadId: ThreadId, detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return this.detail;
  }
}

export class WorkspaceRestore extends Context.Service<
  WorkspaceRestore,
  {
    readonly assertReady: (
      threadId: ThreadId,
      workspace?: ThreadWorkspaceRevision,
    ) => Effect.Effect<void, WorkspaceRestoreError>;
    readonly run: <A, E, R>(
      input: RestoreInput,
      afterFileRestore: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, WorkspaceRestoreError, R>;
  }
>()("t3/workspace/WorkspaceRestore") {}

const isWorkspaceRestoreError = Schema.is(WorkspaceRestoreError);

export const layer = Layer.effect(
  WorkspaceRestore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const terminals = yield* TerminalManager.TerminalManager;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const resolver = yield* WorkspaceRepositoryResolver.WorkspaceRepositoryResolver;
    const assertReady: WorkspaceRestore["Service"]["assertReady"] = Effect.fn(
      "WorkspaceRestore.assertReady",
    )(
      function* (threadId: ThreadId, workspace?: ThreadWorkspaceRevision) {
        const rows = yield* sql<{
          stage: string;
        }>`SELECT stage FROM workspace_restores WHERE thread_id = ${threadId}`;
        let sharedRecovery = false;
        for (const resource of workspace?.resources ?? []) {
          const blocked =
            yield* sql`SELECT thread_id FROM workspace_restores j WHERE stage != 'complete' AND EXISTS (SELECT 1 FROM json_each(j.payload_json, '$.workspace.resources') r WHERE json_extract(r.value, '$.id') = ${resource.id}) LIMIT 1`;
          if (blocked.length > 0) sharedRecovery = true;
        }
        if (sharedRecovery || (rows[0] && rows[0].stage !== "complete"))
          return yield* new WorkspaceRestoreError({
            threadId,
            detail:
              "Group recovery is required. A restore did not finish; its backup refs and recovery journal have been retained. Inspect all repositories and the provider conversation before resuming.",
          });
      },
      (effect, threadId, _workspace) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isWorkspaceRestoreError(cause)
              ? cause
              : new WorkspaceRestoreError({
                  threadId,
                  detail: "Cannot verify group recovery state.",
                  cause,
                }),
          ),
        ),
    );
    const run = Effect.fn("WorkspaceRestore.run")(function* <A, E, R>(
      input: RestoreInput,
      afterFileRestore: Effect.Effect<A, E, R>,
    ) {
      return yield* Effect.gen(function* () {
        yield* assertReady(input.threadId, input.workspace);
        const { workspace, checkpoint } = input;
        const terminalState = yield* Ref.make<ReadonlyArray<TerminalSummary>>([]);
        const openTerminals = yield* Effect.acquireUseRelease(
          terminals.subscribeMetadata((event) =>
            event.type === "snapshot" ? Ref.set(terminalState, event.terminals) : Effect.void,
          ),
          () => Ref.get(terminalState),
          (stop) => Effect.sync(stop),
        );
        if (
          openTerminals.some(
            (terminal) =>
              ["starting", "running"].includes(terminal.status) &&
              workspace.resources.some(
                (resource) =>
                  workspaceRelativeFilePath(terminal.cwd, resource.checkoutRoot) !== null,
              ),
          )
        )
          return yield* new WorkspaceRestoreError({
            threadId: input.threadId,
            detail: "Close all workspace terminals before restoring files.",
          });
        if (
          checkpoint.status !== "ready" ||
          checkpoint.resources?.length !== workspace.resources.length
        )
          return yield* new WorkspaceRestoreError({
            threadId: input.threadId,
            detail: "The checkpoint set is incomplete.",
          });
        for (const resource of workspace.resources) {
          const member = checkpoint.resources.find((entry) => entry.resourceId === resource.id);
          yield* resolver.verify(resource.identity);
          if (
            resource.ownership !== "managed" ||
            member?.status !== "ready" ||
            !(yield* checkpoints.hasCheckpointRef({
              cwd: resource.checkoutRoot,
              checkpointRef: member.ref,
            }))
          )
            return yield* new WorkspaceRestoreError({
              threadId: input.threadId,
              detail: `Repository ${resource.name} cannot be restored from this checkpoint.`,
            });
        }
        const token = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        const backups: Array<(typeof RestoreJournal.Type)["backups"][number]> = [];
        for (const [index, resource] of workspace.resources.entries()) {
          const indexPath = path.join(resource.identity.gitDir, "index");
          backups.push({
            cwd: resource.checkoutRoot,
            ref: CheckpointRef.make(`refs/t3/workspace-restore/${token}/${index}`),
            indexPath,
            indexBackup: (yield* fs.exists(indexPath))
              ? path.join(resource.identity.gitDir, `t3-restore-${token}.index`)
              : null,
          });
        }
        const payload = yield* Schema.encodeEffect(json)({ workspace, backups });
        const stage = Effect.fn("WorkspaceRestore.stage")(function* (value: string) {
          yield* sql`INSERT INTO workspace_restores (thread_id, stage, payload_json) VALUES (${input.threadId}, ${value}, ${payload}) ON CONFLICT(thread_id) DO UPDATE SET stage = excluded.stage, payload_json = excluded.payload_json`;
        });
        let mutated = false;
        let providerStarted = false;
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* stage("backing-up");
            for (const backup of backups) {
              if (backup.indexBackup !== null)
                yield* fs.copyFile(backup.indexPath, backup.indexBackup);
              yield* checkpoints.captureCheckpoint({ cwd: backup.cwd, checkpointRef: backup.ref });
              if (
                !(yield* checkpoints.hasCheckpointRef({
                  cwd: backup.cwd,
                  checkpointRef: backup.ref,
                }))
              )
                return yield* new WorkspaceRestoreError({
                  threadId: input.threadId,
                  detail: "A repository backup could not be verified; files were not restored.",
                });
            }
            yield* stage("restoring-files");
            mutated = true;
            for (const resource of workspace.resources) {
              const member = checkpoint.resources!.find(
                (entry) => entry.resourceId === resource.id,
              )!;
              if (
                !(yield* checkpoints.restoreCheckpoint({
                  cwd: resource.checkoutRoot,
                  checkpointRef: member.ref,
                  fallbackToHead: false,
                }))
              )
                return yield* new WorkspaceRestoreError({
                  threadId: input.threadId,
                  detail: `Could not restore ${resource.name}.`,
                });
            }
            yield* stage("provider-and-event-commit");
            providerStarted = true;
            const result = yield* afterFileRestore;
            yield* stage("complete");
            return result;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                let compensated = !mutated;
                if (mutated) {
                  const results = yield* Effect.forEach(backups, (backup) =>
                    Effect.gen(function* () {
                      const restored = yield* checkpoints.restoreCheckpoint({
                        cwd: backup.cwd,
                        checkpointRef: backup.ref,
                        fallbackToHead: false,
                      });
                      if (!restored) return false;
                      if (backup.indexBackup === null)
                        yield* fs.remove(backup.indexPath, { force: true });
                      else yield* fs.copyFile(backup.indexBackup, backup.indexPath);
                      return true;
                    }).pipe(Effect.orElseSucceed(() => false)),
                  );
                  compensated = results.every(Boolean);
                }
                yield* stage(compensated && !providerStarted ? "complete" : "recovery-required");
                return yield* new WorkspaceRestoreError({
                  threadId: input.threadId,
                  detail:
                    compensated && !providerStarted
                      ? "Workspace restore failed; all repositories were restored to their pre-operation contents."
                      : "Workspace restore has an uncertain result. Further turns are blocked; backup refs and the recovery journal have been retained.",
                  cause: Cause.squash(cause),
                });
              }),
            ),
          ),
        );
      }).pipe(
        Effect.mapError((cause) =>
          isWorkspaceRestoreError(cause)
            ? cause
            : new WorkspaceRestoreError({
                threadId: input.threadId,
                detail: "Workspace restore failed before completion.",
                cause,
              }),
        ),
      );
    });
    return WorkspaceRestore.of({ assertReady, run });
  }),
);

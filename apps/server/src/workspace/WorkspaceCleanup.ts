import { ThreadId, ThreadWorkspaceRevision, WorkspaceRevisionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as WorkspaceRepositoryResolver from "./WorkspaceRepositoryResolver.ts";
import { withWorkspaceLeases } from "./workspaceLease.ts";

export class WorkspaceCleanupError extends Schema.TaggedError<WorkspaceCleanupError>()(
  "WorkspaceCleanupError",
  {
    revisionId: WorkspaceRevisionId,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}

export class WorkspaceCleanup extends Context.Service<
  WorkspaceCleanup,
  {
    readonly remove: (input: {
      readonly threadId: ThreadId;
      readonly workspace: ThreadWorkspaceRevision;
      readonly managedRoots: ReadonlyArray<string>;
      readonly isOccupied: (checkoutRoot: string) => Effect.Effect<boolean, WorkspaceCleanupError>;
    }) => Effect.Effect<void, WorkspaceCleanupError>;
  }
>()("t3/workspace/WorkspaceCleanup") {}

const isWorkspaceCleanupError = Schema.is(WorkspaceCleanupError);

export const layer = Layer.effect(
  WorkspaceCleanup,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const resolver = yield* WorkspaceRepositoryResolver.WorkspaceRepositoryResolver;
    return WorkspaceCleanup.of({
      remove: Effect.fn("WorkspaceCleanup.remove")(
        function* (input) {
          const { workspace } = input;
          const reject = (detail: string) =>
            new WorkspaceCleanupError({ revisionId: workspace.id, detail });
          return yield* withWorkspaceLeases(
            workspace.resources.map((resource) => `resource:${resource.id}`),
            withWorkspaceLeases(
              workspace.resources.map((resource) => resource.checkoutRoot),
              Effect.gen(function* () {
                const assertUnused = Effect.fn("WorkspaceCleanup.assertUnused")(function* () {
                  const owner = yield* sql<{
                    deleted_at: string | null;
                  }>`SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ${input.threadId}`;
                  if (owner[0]?.deleted_at == null)
                    return yield* reject("Only deleted tasks can release a worktree group.");
                  const restores = yield* sql<{
                    stage: string;
                  }>`SELECT stage FROM workspace_restores WHERE thread_id = ${input.threadId} AND stage != 'complete'`;
                  if (restores.length > 0)
                    return yield* reject("The workspace has an unfinished restore.");
                  for (const resource of workspace.resources) {
                    if (yield* input.isOccupied(resource.checkoutRoot))
                      return yield* reject(
                        `${resource.name} has an open terminal or provider session.`,
                      );
                    const references = yield* sql<{ thread_id: string }>`
                SELECT thread_id FROM orchestration_v2_projection_threads t
                WHERE thread_id != ${input.threadId} AND deleted_at IS NULL AND (
                  json_extract(payload_json, '$.worktreePath') = ${resource.checkoutRoot}
                  OR json_extract(payload_json, '$.projectWorkspaceRoot') = ${resource.checkoutRoot}
                  OR EXISTS (SELECT 1 FROM json_each(t.payload_json, '$.workspace.resources') r WHERE json_extract(r.value, '$.id') = ${resource.id})
                ) LIMIT 1`;
                    if (references.length > 0)
                      return yield* reject(`${resource.name} is shared by another task.`);
                    const projectPaths = yield* sql<{ source_path: string }>`
                      SELECT workspace_root AS source_path FROM projection_projects WHERE deleted_at IS NULL
                      UNION SELECT json_extract(r.value, '$.sourcePath') AS source_path FROM projection_projects p, json_each(p.workspace_config_json, '$.roots') r WHERE p.deleted_at IS NULL`;
                    const history = yield* sql<{ source_path: string }>`
                      SELECT json_extract(r.value, '$.checkoutRoot') AS source_path
                      FROM orchestration_v2_projection_checkpoint_scopes s
                      JOIN orchestration_v2_projection_threads t ON t.thread_id = s.thread_id,
                      json_each(s.payload_json, '$.workspace.resources') r
                      WHERE t.thread_id != ${input.threadId} AND t.deleted_at IS NULL
                      UNION
                      SELECT json_extract(s.payload_json, '$.cwd') AS source_path
                      FROM orchestration_v2_projection_checkpoint_scopes s
                      JOIN orchestration_v2_projection_threads t ON t.thread_id = s.thread_id
                      WHERE t.thread_id != ${input.threadId} AND t.deleted_at IS NULL
                        AND json_extract(s.payload_json, '$.cwd') IS NOT NULL`;
                    for (const reference of [...projectPaths, ...history]) {
                      const sourcePath = yield* fs.realPath(reference.source_path).pipe(
                        Effect.catchIf(
                          (error) => error.reason._tag === "NotFound",
                          () => Effect.succeed(path.resolve(reference.source_path)),
                        ),
                      );
                      const relative = path.relative(resource.checkoutRoot, sourcePath);
                      if (
                        relative === "" ||
                        (!path.isAbsolute(relative) &&
                          relative !== ".." &&
                          !relative.startsWith(`..${path.sep}`))
                      )
                        return yield* reject(
                          `${resource.name} is used by a project or another task's history.`,
                        );
                    }
                  }
                });
                yield* assertUnused();
                const journal = yield* sql<{
                  resource_id: string;
                  stage: string;
                }>`SELECT resource_id, stage FROM workspace_cleanup_resources WHERE revision_id = ${workspace.id}`;
                const stages = new Map(journal.map((row) => [row.resource_id, row.stage]));
                const present = [];
                for (const resource of workspace.resources) {
                  if (resource.ownership !== "managed")
                    return yield* reject("Borrowed repositories cannot be removed.");
                  if (!(yield* fs.exists(resource.checkoutRoot))) {
                    if (!stages.has(resource.id))
                      return yield* reject(`${resource.name} disappeared before cleanup.`);
                    continue;
                  }
                  yield* resolver.verify(resource.identity);
                  if (
                    !input.managedRoots.some((root) => {
                      const relative = path.relative(root, resource.checkoutRoot);
                      return (
                        relative !== "" &&
                        relative !== ".." &&
                        !relative.startsWith(`..${path.sep}`) &&
                        !path.isAbsolute(relative)
                      );
                    })
                  )
                    return yield* reject(
                      `${resource.name} is outside the managed worktree directories.`,
                    );
                  const status = yield* git.execute({
                    operation: "WorkspaceCleanup.preflight",
                    cwd: resource.checkoutRoot,
                    args: ["status", "--porcelain", "--untracked-files=all", "--ignored"],
                  });
                  if (status.stdout.trim() !== "" || status.stdoutTruncated)
                    return yield* reject(
                      `${resource.name} has local files or changes; the whole group was retained.`,
                    );
                  present.push(resource);
                }
                // Persist intent before removing any checkout; a retry can recognize completed removals.
                for (const resource of workspace.resources)
                  yield* sql`INSERT INTO workspace_cleanup_resources (revision_id, resource_id, stage) VALUES (${workspace.id}, ${resource.id}, 'planned') ON CONFLICT DO NOTHING`;
                for (const resource of present) {
                  yield* assertUnused();
                  yield* resolver.verify(resource.identity);
                  yield* git.execute({
                    operation: "WorkspaceCleanup.remove",
                    cwd: path.dirname(resource.checkoutRoot),
                    args: [
                      "--git-dir",
                      resource.identity.commonDir,
                      "worktree",
                      "remove",
                      "--",
                      resource.checkoutRoot,
                    ],
                  });
                  yield* sql`UPDATE workspace_cleanup_resources SET stage = 'removed' WHERE revision_id = ${workspace.id} AND resource_id = ${resource.id}`;
                }
              }),
            ),
          );
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isWorkspaceCleanupError(cause)
                ? cause
                : new WorkspaceCleanupError({
                    revisionId: input.workspace.id,
                    detail:
                      "Group cleanup stopped; remaining checkouts and all branches were retained for retry.",
                    cause,
                  }),
            ),
          ),
      ),
    });
  }),
);

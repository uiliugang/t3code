import * as WorkspaceCleanup from "./WorkspaceCleanup.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  WorkspaceRootId,
  type ProjectWorkspaceRoot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceRepositoryResolver from "./WorkspaceRepositoryResolver.ts";
import * as WorkspaceProvisioner from "./WorkspaceProvisioner.ts";

const infrastructure = Layer.mergeAll(
  Sqlite.layerMemory,
  GitVcsDriver.layer,
  WorkspaceRepositoryResolver.layer.pipe(Layer.provide(GitVcsDriver.layer)),
).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "workspace-preparation-" })),
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.live(
  "retains partial groups, resumes without recreating successful repositories, and freezes launch roots",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const sql = yield* SqlClient.SqlClient;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "workspace-group-test-" });
      const fail = yield* Ref.make(true);
      const roots: Array<ProjectWorkspaceRoot> = [];
      for (const alias of ["frontend", "backend"]) {
        const cwd = path.join(temp, alias);
        yield* fs.makeDirectory(cwd);
        yield* git.execute({ operation: "test", cwd, args: ["init", "-b", "main"] });
        yield* fs.writeFileString(path.join(cwd, "file.txt"), alias);
        yield* git.execute({ operation: "test", cwd, args: ["add", "."] });
        yield* git.execute({
          operation: "test",
          cwd,
          args: [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "initial",
          ],
        });
        roots.push({
          id: WorkspaceRootId.make(alias),
          alias,
          sourcePath: cwd,
          description: "",
          accessIntent: "write" as const,
          defaultSelected: true,
          setupScript: {
            id: alias,
            name: "Setup",
            command: "setup",
            icon: "configure" as const,
            runOnWorktreeCreate: true,
          },
        });
      }
      const setupLayer = Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
        runForThread: (input) =>
          Effect.gen(function* () {
            const isFailure = input.worktreePath.endsWith("backend") && (yield* Ref.get(fail));
            yield* fs
              .writeFileString(path.join(input.worktreePath, "setup.txt"), "prepared")
              .pipe(Effect.orDie);
            return {
              status: "started" as const,
              scriptId: "setup",
              scriptName: "Setup",
              scriptCommand: "setup",
              terminalId: "setup",
              cwd: input.worktreePath,
              async: false,
              completion: Effect.succeed({ exitCode: isFailure ? 1 : 0, durationMs: 0 }),
            };
          }),
      });
      const layer = WorkspaceProvisioner.layer.pipe(
        Layer.provide(setupLayer),
        Layer.provide(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          }),
        ),
        Layer.provide(
          Layer.mock(CheckpointStore.CheckpointStore)({ captureCheckpoint: () => Effect.void }),
        ),
        Layer.provide(ServerConfig.layerTest(temp, path.join(temp, "state"))),
      );
      yield* Effect.gen(function* () {
        const provisioner = yield* WorkspaceProvisioner.WorkspaceProvisioner;
        const input = {
          threadId: ThreadId.make("group-test"),
          projectId: ProjectId.make("multi"),
          config: { version: 1, primaryRootId: roots[0]!.id, roots },
          strategy: { type: "worktree" as const, baseRef: "main" },
        };
        yield* git.execute({
          operation: "test",
          cwd: roots[1]!.sourcePath,
          args: ["checkout", "-b", "feature/backend"],
        });
        const invalidBase = yield* provisioner
          .prepare({
            ...input,
            config: {
              ...input.config,
              roots: [roots[0]!, { ...roots[1]!, defaultBaseRef: "feature/backend" }],
            },
          })
          .pipe(Effect.flip);
        assert.include(invalidBase.message, "main or master");
        assert.lengthOf(yield* sql`SELECT * FROM workspace_preparations`, 0);
        const error = yield* provisioner.prepare(input).pipe(Effect.flip);
        assert.include(error.message, "Setup failed");
        const [row] = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM workspace_preparations`;
        assert.isDefined(row);
        const records = yield* git.execute({
          operation: "test",
          cwd: roots[0]!.sourcePath,
          args: ["worktree", "list", "--porcelain"],
        });
        const prepared = records.stdout
          .split("\n")
          .filter((line) => line.startsWith("worktree "))
          .at(-1)!
          .slice(9);
        yield* fs.writeFileString(path.join(prepared, "keep.txt"), "user work");
        yield* Ref.set(fail, false);
        const workspace = yield* provisioner.prepare({
          ...input,
          config: {
            ...input.config,
            version: 2,
            roots: [{ ...roots[0]!, sourcePath: "/missing" }],
          },
        });
        assert.equal(workspace.sourceProjectVersion, 1);
        assert.lengthOf(workspace.resources, 2);
        assert.equal(workspace.resources[0]!.checkoutRoot, prepared);
        assert.equal(yield* fs.readFileString(path.join(prepared, "keep.txt")), "user work");
        for (const resource of workspace.resources) {
          assert.equal(resource.ownership, "managed");
          assert.equal(
            yield* fs.readFileString(path.join(resource.checkoutRoot, "setup.txt")),
            "prepared",
          );
        }
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, deleted_at, payload_json) VALUES (${input.threadId}, ${input.projectId}, 'test', 'codex', 'full-access', 'default', 'now', 'now', 'now', '{}')`;
        yield* Effect.gen(function* () {
          const cleanup = yield* WorkspaceCleanup.WorkspaceCleanup;
          const cleanupInput = {
            threadId: input.threadId,
            workspace,
            managedRoots: [yield* fs.realPath(temp)],
            isOccupied: () => Effect.succeed(false),
          };
          const blocked = yield* cleanup.remove(cleanupInput).pipe(Effect.flip);
          assert.include(blocked.message, "local files");
          for (const resource of workspace.resources)
            assert.isTrue(yield* fs.exists(resource.checkoutRoot));
          yield* fs.remove(path.join(prepared, "keep.txt"));
          for (const resource of workspace.resources)
            yield* fs.remove(path.join(resource.checkoutRoot, "setup.txt"));
          const childRoot = path.join(workspace.resources[1]!.checkoutRoot, "src");
          yield* fs.makeDirectory(childRoot);
          const linkedRoot = path.join(temp, "linked-backend");
          yield* fs.symlink(childRoot, linkedRoot);
          yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('nested-project', 'Nested', ${linkedRoot}, '[]', 'now', 'now')`;
          const shared = yield* cleanup.remove(cleanupInput).pipe(Effect.flip);
          assert.include(shared.message, "used by a project");
          for (const resource of workspace.resources)
            assert.isTrue(yield* fs.exists(resource.checkoutRoot));
          yield* sql`DELETE FROM projection_projects WHERE project_id = 'nested-project'`;
          yield* fs.remove(childRoot, { recursive: true });
          yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES ('legacy-history', ${input.projectId}, 'Legacy', 'codex', 'full-access', 'default', 'now', 'now', '{}')`;
          yield* sql`INSERT INTO orchestration_v2_projection_checkpoint_scopes (scope_id, thread_id, node_id, kind, ordinal_within_parent, advances_app_run_count, created_at, payload_json) VALUES ('legacy-scope', 'legacy-history', 'legacy-node', 'main', 0, 1, 'now', json_object('cwd', ${workspace.resources[1]!.checkoutRoot}))`;
          const historical = yield* cleanup.remove(cleanupInput).pipe(Effect.flip);
          assert.include(historical.message, "another task's history");
          for (const resource of workspace.resources)
            assert.isTrue(yield* fs.exists(resource.checkoutRoot));
          yield* sql`DELETE FROM orchestration_v2_projection_checkpoint_scopes WHERE scope_id = 'legacy-scope'`;
          yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'legacy-history'`;
          const occupied = yield* cleanup
            .remove({
              ...cleanupInput,
              isOccupied: (cwd) => Effect.succeed(cwd === workspace.resources[1]!.checkoutRoot),
            })
            .pipe(Effect.flip);
          assert.include(occupied.message, "open terminal");
          for (const resource of workspace.resources)
            assert.isTrue(yield* fs.exists(resource.checkoutRoot));
          yield* cleanup.remove(cleanupInput);
          yield* cleanup.remove(cleanupInput);
          for (const resource of workspace.resources)
            assert.isFalse(yield* fs.exists(resource.checkoutRoot));
        }).pipe(Effect.provide(WorkspaceCleanup.layer));
        const selected = yield* provisioner.prepare({
          ...input,
          threadId: ThreadId.make("scoped-setup"),
          scripts: [
            {
              id: "scope",
              name: "Scope",
              command: "setup",
              icon: "configure",
              runOnWorktreeCreate: true,
              repositoryRootIds: [roots[1]!.id],
            },
          ],
        });
        assert.isFalse(
          yield* fs.exists(path.join(selected.resources[0]!.checkoutRoot, "setup.txt")),
        );
        assert.isTrue(
          yield* fs.exists(path.join(selected.resources[1]!.checkoutRoot, "setup.txt")),
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(infrastructure), Effect.scoped),
);

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceRepositoryResolver from "./WorkspaceRepositoryResolver.ts";
import * as WorkspaceProvisioner from "./WorkspaceProvisioner.ts";

const infrastructure = Layer.mergeAll(
  WorktreeSetupTracker.layer,
  Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
  Sqlite.layerMemory,
  GitVcsDriver.layer,
  WorkspaceRepositoryResolver.layer.pipe(Layer.provide(GitVcsDriver.layer)),
).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "workspace-preparation-" })),
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.live.each([
  { async: true, exitCode: 0, cancel: false },
  { async: true, exitCode: 1, cancel: false },
  { async: true, exitCode: null, cancel: false },
  { async: false, exitCode: 0, cancel: false },
  { async: false, exitCode: null, cancel: true },
])(
  "honors async=$async with exit $exitCode without racing the workspace baseline",
  ({ async, exitCode, cancel }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "workspace-async-" });
      const started = yield* Deferred.make<void>();
      const completion =
        yield* Deferred.make<ProjectSetupScriptRunner.ProjectSetupScriptCompletion>();
      const baselines = yield* Ref.make<boolean[]>([]);
      const closedTerminals = yield* Ref.make<Array<string | undefined>>([]);
      const cwd = path.join(temp, "source");
      yield* fs.makeDirectory(cwd);
      yield* git.execute({ operation: "test", cwd, args: ["init", "-b", "main"] });
      yield* fs.writeFileString(path.join(cwd, "file.txt"), "initial");
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
      const threadId = ThreadId.make("async-group");
      const rootId = WorkspaceRootId.make("source");
      yield* tracker.begin({
        threadId,
        branch: null,
        baseRef: "main",
        stages: ["fetch", "checkout", "submodules", "setup-script", "agent"],
        fiber: null,
      });
      const layer = WorkspaceProvisioner.layer.pipe(
        Layer.provide(
          Layer.mock(TerminalManager.TerminalManager)({
            close: (input) =>
              Ref.update(closedTerminals, (current) => [...current, input.terminalId]),
          }),
        ),
        Layer.provide(
          Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
            runForThread: (input) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                assert.deepEqual(yield* Ref.get(baselines), async ? [false] : []);
                const snapshot = yield* tracker.get(threadId);
                assert.equal(
                  snapshot?.stages.find((stage) => stage.id === "checkout")?.status,
                  "done",
                );
                if (input.observeCompletion?.onOutputLine)
                  yield* input.observeCompletion.onOutputLine("installing dependencies");
                yield* fs
                  .writeFileString(path.join(input.worktreePath, "generated.txt"), "setup output")
                  .pipe(Effect.orDie);
                return {
                  status: "started" as const,
                  scriptId: "setup",
                  scriptName: "Setup",
                  scriptCommand: "setup",
                  terminalId: "setup",
                  cwd: input.worktreePath,
                  async,
                  completion: Deferred.await(completion),
                };
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(CheckpointStore.CheckpointStore)({
            captureCheckpoint: (input) =>
              fs.exists(path.join(input.cwd, "generated.txt")).pipe(
                Effect.flatMap((generated) =>
                  Ref.update(baselines, (current) => [...current, generated]),
                ),
                Effect.orDie,
              ),
          }),
        ),
        Layer.provide(ServerConfig.layerTest(temp, path.join(temp, "state"))),
      );
      yield* Effect.gen(function* () {
        const provisioner = yield* WorkspaceProvisioner.WorkspaceProvisioner;
        const preparing = yield* provisioner
          .prepare({
            threadId,
            projectId: ProjectId.make("async-project"),
            config: {
              version: 1,
              primaryRootId: rootId,
              roots: [
                {
                  id: rootId,
                  alias: "source",
                  sourcePath: cwd,
                  description: "",
                  accessIntent: "write",
                  defaultSelected: true,
                  setupScript: {
                    id: "setup",
                    name: "Setup",
                    command: "setup",
                    icon: "configure",
                    runOnWorktreeCreate: true,
                    async,
                  },
                },
              ],
            },
            strategy: { type: "worktree", baseRef: "main", startFromOrigin: false },
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        if (cancel) {
          yield* tracker.stream(threadId).pipe(
            Stream.filter((snapshot) => snapshot?.setupScript?.terminalId === "setup"),
            Stream.runHead,
          );
          yield* Fiber.interrupt(preparing);
          assert.deepEqual(yield* Ref.get(closedTerminals), ["setup"]);
          assert.deepEqual(yield* Ref.get(baselines), []);
          return;
        }
        if (!async) yield* Deferred.succeed(completion, { exitCode: 0, durationMs: 1 });
        const prepared = yield* Fiber.join(preparing);
        assert.equal(yield* Deferred.isDone(completion), !async);
        assert.deepEqual(yield* Ref.get(baselines), [!async]);
        const snapshot = yield* tracker.get(threadId);
        assert.include(
          snapshot?.stages.find((stage) => stage.id === "setup-script")?.tail ?? [],
          "installing dependencies",
        );
        if (async) yield* Deferred.succeed(completion, { exitCode, durationMs: 1 });
        if (exitCode === 0) yield* prepared.completion;
        else assert.include((yield* prepared.completion.pipe(Effect.flip)).message, "Setup failed");
        const settled = yield* tracker.get(threadId);
        const setupStage = settled?.stages.find((stage) => stage.id === "setup-script");
        assert.equal(setupStage?.status, exitCode === 0 ? "done" : "failed");
        assert.isNotNull(setupStage?.endedAt);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(infrastructure), Effect.scoped),
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
      const setupBranches = yield* Ref.make<string[]>([]);
      const checkoutModes = yield* Ref.make<Array<boolean | undefined>>([]);
      const generatedBranch = "lg/fix-group-branches";
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
            async: false,
          },
        });
      }
      const setupLayer = Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
        runForThread: (input) =>
          Effect.gen(function* () {
            const branch = (yield* git
              .execute({
                operation: "test",
                cwd: input.worktreePath,
                args: ["branch", "--show-current"],
              })
              .pipe(Effect.orDie)).stdout.trim();
            yield* Ref.update(setupBranches, (branches) => [...branches, branch]);
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
          Layer.succeed(GitVcsDriver.GitVcsDriver, {
            ...git,
            createWorktree: (input, options) =>
              Ref.update(checkoutModes, (modes) => [...modes, options?.fastCheckout]).pipe(
                Effect.andThen(git.createWorktree(input, options)),
              ),
          }),
        ),
        Layer.provide(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              fastWorktreeCheckout: true,
            }),
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
          generatedBranchName: { branch: generatedBranch, exactName: false },
        };
        yield* git.execute({
          operation: "test",
          cwd: roots[1]!.sourcePath,
          args: ["checkout", "-b", "feature/backend"],
        });
        yield* git.execute({
          operation: "test",
          cwd: roots[1]!.sourcePath,
          args: ["branch", generatedBranch],
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
        assert.deepEqual(yield* Ref.get(checkoutModes), [true, true]);
        assert.deepEqual(yield* Ref.get(setupBranches), [generatedBranch, `${generatedBranch}-1`]);
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
        const { workspace } = yield* provisioner.prepare({
          ...input,
          generatedBranchName: { branch: "lg/different-on-retry", exactName: false },
          config: {
            ...input.config,
            version: 2,
            roots: [{ ...roots[0]!, sourcePath: "/missing" }],
          },
        });
        assert.equal(workspace.sourceProjectVersion, 1);
        assert.deepEqual(yield* Ref.get(checkoutModes), [true, true]);
        assert.lengthOf(workspace.resources, 2);
        assert.deepEqual(
          workspace.bindings.map((binding) => binding.launchBranch),
          [generatedBranch, `${generatedBranch}-1`],
        );
        assert.deepEqual(yield* Ref.get(setupBranches), [
          generatedBranch,
          `${generatedBranch}-1`,
          `${generatedBranch}-1`,
        ]);
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
        const { workspace: selected } = yield* provisioner.prepare({
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
        const { workspace: explicit } = yield* provisioner.prepare({
          ...input,
          threadId: ThreadId.make("explicit-group-branch"),
          strategy: { type: "worktree", baseRef: "main", branch: "feature/user-choice" },
        });
        assert.deepEqual(
          explicit.bindings.map((binding) => binding.launchBranch),
          ["feature/user-choice", "feature/user-choice"],
        );
        const { workspace: fallback } = yield* provisioner.prepare({
          ...input,
          threadId: ThreadId.make("group-name-unavailable"),
          generatedBranchName: undefined,
        });
        for (const binding of fallback.bindings) assert.match(binding.launchBranch!, /^t3-multi-/);
        yield* git.execute({
          operation: "test",
          cwd: roots[0]!.sourcePath,
          args: ["checkout", "main"],
        });
        const { workspace: local } = yield* provisioner.prepare({
          ...input,
          threadId: ThreadId.make("local-protected-main"),
          strategy: { type: "root" },
        });
        assert.equal(local.mode, "existing");
        assert.match(local.bindings[0]!.launchBranch!, /^t3\//);
        assert.equal(local.bindings[1]!.launchBranch, "feature/backend");
        assert.equal(local.resources[0]!.checkoutRoot, yield* fs.realPath(roots[0]!.sourcePath));
        const preparedPath = path.join(temp, "prepared-pr");
        yield* git.execute({
          operation: "test",
          cwd: roots[0]!.sourcePath,
          args: ["worktree", "add", "-b", "feature/prepared-pr", preparedPath, "main"],
        });
        yield* fs.writeFileString(path.join(preparedPath, "pr.txt"), "PR head");
        yield* git.execute({ operation: "test", cwd: preparedPath, args: ["add", "."] });
        yield* git.execute({
          operation: "test",
          cwd: preparedPath,
          args: ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "PR"],
        });
        const preparedHead = (yield* git.execute({
          operation: "test",
          cwd: preparedPath,
          args: ["rev-parse", "HEAD"],
        })).stdout.trim();
        const existingInput = {
          ...input,
          threadId: ThreadId.make("prepared-pr"),
          config: { ...input.config, roots: [roots[0]!] },
          strategy: {
            type: "existing_worktree" as const,
            worktreePath: preparedPath,
            branch: "feature/prepared-pr",
          },
        };
        const { workspace: existing } = yield* provisioner.prepare(existingInput);
        assert.equal(existing.mode, "isolated");
        assert.equal(existing.resources[0]!.checkoutRoot, yield* fs.realPath(preparedPath));
        assert.equal(existing.resources[0]!.ownership, "borrowed");
        assert.equal(existing.bindings[0]!.launchBranch, "feature/prepared-pr");
        assert.equal(existing.bindings[0]!.launchBaseCommit, preparedHead);
        assert.equal(
          existing.bindings[0]!.sourcePathAtBind,
          yield* fs.realPath(roots[0]!.sourcePath),
        );
        assert.isFalse(yield* fs.exists(path.join(preparedPath, "setup.txt")));
        for (const [suffix, config, strategy, message] of [
          ["multi", input.config, existingInput.strategy, "single existing worktree"],
          [
            "branch",
            existingInput.config,
            { ...existingInput.strategy, branch: "changed" },
            "branch",
          ],
          [
            "repository",
            existingInput.config,
            { ...existingInput.strategy, worktreePath: roots[1]!.sourcePath },
            "another repository",
          ],
        ] as const) {
          const denied = yield* provisioner
            .prepare({
              ...existingInput,
              threadId: ThreadId.make(`prepared-pr-${suffix}`),
              config,
              strategy,
            })
            .pipe(Effect.flip);
          assert.include(denied.message, message);
        }
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(infrastructure), Effect.scoped),
);

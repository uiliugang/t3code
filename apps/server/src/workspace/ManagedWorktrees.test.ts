import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  OrchestrationV2AppThread,
  ThreadId,
  type ThreadWorkspaceRevision,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { planWorkspaceBinding } from "../orchestration-v2/WorkspaceBinding.ts";
import {
  workspaceFixture,
  workspaceThreadFixture,
} from "../orchestration-v2/testkit/workspaceFixtures.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ManagedWorktrees from "./ManagedWorktrees.ts";
import * as WorkspaceRepositoryResolver from "./WorkspaceRepositoryResolver.ts";

const infrastructure = Layer.mergeAll(
  GitVcsDriver.layer,
  WorkspaceRepositoryResolver.layer.pipe(Layer.provide(GitVcsDriver.layer)),
  ProjectStore.layer,
).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "managed-worktrees-" })),
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const encodeThread = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2AppThread));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const resolver = yield* WorkspaceRepositoryResolver.WorkspaceRepositoryResolver;
  const temp = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "manual-worktrees-" }),
  );
  const managed = path.join(temp, "worktrees");
  const base = workspaceFixture();
  const resources: ThreadWorkspaceRevision["resources"][number][] = [];
  const bindings: ThreadWorkspaceRevision["bindings"][number][] = [];
  for (const resource of base.resources) {
    const source = path.join(temp, resource.name);
    const checkout = path.join(managed, resource.name);
    yield* fs.makeDirectory(source, { recursive: true });
    yield* git.execute({ operation: "test", cwd: source, args: ["init", "-b", "main"] });
    yield* fs.writeFileString(path.join(source, "file.txt"), resource.name);
    yield* fs.writeFileString(path.join(source, ".gitignore"), ".env\nnode_modules/\n");
    yield* git.execute({ operation: "test", cwd: source, args: ["add", "."] });
    yield* git.execute({
      operation: "test",
      cwd: source,
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
    yield* git.execute({
      operation: "test",
      cwd: source,
      args: ["worktree", "add", "-b", `feature/${resource.name}`, checkout],
    });
    const identity = yield* resolver.inspect(checkout);
    resources.push({ ...resource, checkoutRoot: checkout, identity });
    bindings.push({
      ...base.bindings.find((binding) => binding.resourceId === resource.id)!,
      sourcePathAtBind: source,
      executionPath: checkout,
    });
  }
  const workspace = { ...base, resources, bindings };
  const thread = {
    ...workspaceThreadFixture(workspace),
    worktreePath: resources[0]!.checkoutRoot,
    branch: "feature/frontend",
  };
  const projection = yield* Ref.make(
    ProjectionStore.emptyProjection({
      type: "thread.created",
      id: EventId.make("created"),
      threadId: thread.id,
      occurredAt: thread.createdAt,
      payload: thread,
    }),
  );
  const persist = Effect.fn("test.persist")(function* (value: OrchestrationV2AppThread) {
    const payload = yield* encodeThread(value);
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${value.id}, ${value.projectId}, ${value.title}, 'codex', 'full-access', 'default', 'now', 'now', ${payload}) ON CONFLICT(thread_id) DO UPDATE SET payload_json = excluded.payload_json`;
  });
  yield* persist(thread);
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${thread.projectId}, 'Example project', ${bindings[0]!.sourcePathAtBind}, '[]', '2026-10-28T00:00:00Z', '2026-10-28T00:00:00Z')`;
  const rejectBinding = yield* Ref.make(false);
  const layer = ManagedWorktrees.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, worktreesDirectory: managed }),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          subscribeMetadata: (listener) =>
            listener({ type: "snapshot", terminals: [] }).pipe(Effect.as(() => {})),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          isLive: () => Effect.succeed(false),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Ref.get(projection),
          getThreadShell: () => Effect.succeed(null),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          dispatch: (command) =>
            Effect.gen(function* () {
              if (command.type !== "thread.workspace.bind")
                return yield* Effect.die("Unexpected command");
              if (yield* Ref.getAndSet(rejectBinding, false))
                return yield* new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "interrupted binding",
                });
              const current = yield* Ref.get(projection);
              const bound = Result.getOrThrow(
                planWorkspaceBinding({
                  command,
                  projection: current,
                  now: current.thread.updatedAt,
                }),
              );
              yield* Ref.set(projection, { ...current, thread: bound });
              yield* persist(bound).pipe(Effect.orDie);
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        ServerConfig.layerTest(temp, path.join(temp, "state")),
      ),
    ),
  );
  return {
    temp,
    fs,
    path,
    sql,
    git,
    resolver,
    resources,
    workspace,
    thread,
    projection,
    persist,
    rejectBinding,
    layer,
  };
});

it.live(
  "preflights the whole group, rejects stale selections, retains branches and rebuilds every repository after an interrupted binding",
  () =>
    Effect.gen(function* () {
      const context = yield* fixture;
      const { fs, path, git, resources, thread, projection, rejectBinding, resolver, sql } =
        context;
      yield* Effect.gen(function* () {
        const service = yield* ManagedWorktrees.ManagedWorktrees;
        const [initial] = yield* service.list({});
        assert.equal(initial?.status, "ready");
        assert.lengthOf(initial!.resources, 2);
        yield* fs.writeFileString(path.join(resources[1]!.checkoutRoot, "untracked.txt"), "keep");
        const [blocked] = yield* service.list({});
        assert.equal(blocked!.status, "blocked");
        assert.equal(
          (yield* service.remove({ targets: [initial!], deleteIgnoredFiles: false }))[0]!.outcome,
          "failed",
        );
        for (const resource of resources) assert.isTrue(yield* fs.exists(resource.checkoutRoot));
        yield* fs.remove(path.join(resources[1]!.checkoutRoot, "untracked.txt"));
        yield* git.execute({
          operation: "test",
          cwd: resources[1]!.checkoutRoot,
          args: ["worktree", "lock", resources[1]!.checkoutRoot],
        });
        assert.equal((yield* service.list({}))[0]!.status, "blocked");
        yield* git.execute({
          operation: "test",
          cwd: resources[1]!.checkoutRoot,
          args: ["worktree", "unlock", resources[1]!.checkoutRoot],
        });
        yield* fs.writeFileString(
          path.join(resources[0]!.checkoutRoot, ".env"),
          "LOCAL_VALUE=fixture",
        );
        const [withIgnored] = yield* service.list({});
        assert.isTrue(withIgnored!.resources.some((resource) => resource.ignoredFiles));
        assert.equal(
          (yield* service.remove({ targets: [withIgnored!], deleteIgnoredFiles: false }))[0]!
            .outcome,
          "failed",
        );
        const result = yield* service.remove({ targets: [withIgnored!], deleteIgnoredFiles: true });
        assert.equal(result[0]!.outcome, "removed", result[0]!.detail);
        assert.equal((yield* service.list({}))[0]!.status, "removed");
        for (const resource of resources) {
          assert.isFalse(yield* fs.exists(resource.checkoutRoot));
          yield* git.execute({
            operation: "test",
            cwd: resource.identity.commonDir,
            args: [
              "--git-dir",
              resource.identity.commonDir,
              "rev-parse",
              `refs/heads/feature/${resource.name}`,
            ],
          });
        }
        yield* Ref.set(rejectBinding, true);
        yield* service.restore({ threadId: thread.id }).pipe(Effect.flip);
        assert.lengthOf(yield* sql`SELECT * FROM managed_worktree_snapshots`, 1);
        yield* fs.writeFileString(path.join(resources[0]!.checkoutRoot, "recovery.txt"), "keep");
        const [pending] = yield* service.list({});
        assert.equal(pending!.status, "blocked");
        assert.isTrue(pending!.recoveryPending);
        yield* service.restore({ threadId: thread.id });
        assert.equal(
          yield* fs.readFileString(path.join(resources[0]!.checkoutRoot, "recovery.txt")),
          "keep",
        );
        yield* fs.remove(path.join(resources[0]!.checkoutRoot, "recovery.txt"));
        const restored = (yield* Ref.get(projection)).thread.workspace!;
        assert.notEqual(restored.id, context.workspace.id);
        for (const resource of restored.resources) {
          yield* resolver.verify(resource.identity);
          assert.equal(
            yield* fs.readFileString(path.join(resource.checkoutRoot, "file.txt")),
            resource.name,
          );
          assert.equal(resource.generation, 2);
        }
        assert.lengthOf(yield* sql`SELECT * FROM managed_worktree_snapshots`, 0);
        assert.equal((yield* service.list({}))[0]!.status, "ready");
      }).pipe(Effect.provide(context.layer));
    }).pipe(Effect.provide(infrastructure), Effect.scoped),
);

it.live("deduplicates shared checkouts, protects nested project roots and filters by project", () =>
  Effect.gen(function* () {
    const context = yield* fixture;
    const { thread, persist, sql, resources, fs, path, git } = context;
    yield* persist({
      ...thread,
      id: ThreadId.make("shared"),
      workspace: undefined,
      title: "Shared",
      worktreePath: resources[0]!.checkoutRoot,
    });
    yield* Effect.gen(function* () {
      const service = yield* ManagedWorktrees.ManagedWorktrees;
      const scratch = path.join(context.temp, "scratch");
      yield* fs.makeDirectory(scratch);
      yield* persist({
        ...thread,
        id: ThreadId.make("scratch"),
        workspace: undefined,
        branch: null,
        worktreePath: scratch,
      });
      const groups = yield* service.list({});
      assert.lengthOf(groups, 1);
      assert.lengthOf(groups[0]!.threads, 2);
      assert.lengthOf(groups[0]!.resources, 2);
      assert.lengthOf(yield* service.list({ projectIds: [] }), 0);
      const nested = path.join(resources[1]!.checkoutRoot, "nested");
      yield* fs.makeDirectory(nested);
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('nested', 'Nested', ${nested}, '[]', '2026-10-28T00:00:00Z', '2026-10-28T00:00:00Z')`;
      const [blocked] = yield* service.list({});
      assert.equal(blocked!.status, "blocked");
      assert.include(blocked!.reason!, "project checkout");
      for (const resource of resources) assert.isTrue(yield* fs.exists(resource.checkoutRoot));
      yield* sql`DELETE FROM projection_projects WHERE project_id = 'nested'`;
      const nestedCheckout = path.join(resources[0]!.checkoutRoot, "node_modules", "nested");
      yield* git.execute({
        operation: "test",
        cwd: resources[1]!.checkoutRoot,
        args: ["worktree", "add", "--detach", nestedCheckout, "HEAD"],
      });
      yield* persist({
        ...thread,
        id: ThreadId.make("nested-thread"),
        workspace: undefined,
        worktreePath: nestedCheckout,
      });
      const nestedGroups = yield* service.list({});
      assert.lengthOf(nestedGroups, 1);
      assert.equal(nestedGroups[0]!.status, "blocked");
      assert.include(nestedGroups[0]!.reason!, "Nested worktrees");
      assert.equal(
        (yield* service.remove({ targets: [nestedGroups[0]!], deleteIgnoredFiles: true }))[0]!
          .outcome,
        "failed",
      );
      assert.isTrue(yield* fs.exists(nestedCheckout));
    }).pipe(Effect.provide(context.layer));
  }).pipe(Effect.provide(infrastructure), Effect.scoped),
);

it.live("classifies missing and leftover worktrees without losing historical branches", () =>
  Effect.gen(function* () {
    const context = yield* fixture;
    const { resources, git, fs, path, workspace } = context;
    yield* Effect.gen(function* () {
      const service = yield* ManagedWorktrees.ManagedWorktrees;
      for (const resource of resources) {
        yield* git.execute({
          operation: "test",
          cwd: resource.identity.commonDir,
          args: [
            "--git-dir",
            resource.identity.commonDir,
            "worktree",
            "remove",
            resource.checkoutRoot,
          ],
        });
        const [group] = yield* service.list({});
        assert.equal(group!.status, resource === resources[0] ? "blocked" : "removed");
        assert.propertyVal(
          group!.resources.find((entry) => entry.path === resource.checkoutRoot)!,
          "inspection",
          "missing",
        );
        assert.equal(
          group!.resources.find((entry) => entry.path === resource.checkoutRoot)!.branch,
          workspace.bindings.find((binding) => binding.resourceId === resource.id)!.launchBranch,
        );
      }
      const [missing] = yield* service.list({});
      assert.isFalse(missing!.recoveryPending);
      assert.deepEqual(missing!.actions, { remove: false, restore: false });
      const leftover = resources[0]!.checkoutRoot;
      yield* fs.makeDirectory(leftover);
      yield* fs.writeFileString(path.join(leftover, "notes.txt"), "keep");
      const [retained] = yield* service.list({});
      assert.equal(retained!.status, "blocked");
      assert.propertyVal(
        retained!.resources.find((entry) => entry.path === leftover)!,
        "inspection",
        "non-git",
      );
      assert.equal(
        (yield* service.remove({ targets: [retained!], deleteIgnoredFiles: true }))[0]!.outcome,
        "failed",
      );
      assert.equal(yield* fs.readFileString(path.join(leftover, "notes.txt")), "keep");
    }).pipe(Effect.provide(context.layer));
  }).pipe(Effect.provide(infrastructure), Effect.scoped),
);

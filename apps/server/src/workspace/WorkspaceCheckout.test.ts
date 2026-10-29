import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  WorkspaceRevisionId,
  WorkspaceRootId,
  type OrchestrationV2AppThread,
  type Project,
  type ProjectWorkspaceRoot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { emptyProjection } from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { planWorkspaceBinding } from "../orchestration-v2/WorkspaceBinding.ts";
import {
  workspaceFixture,
  workspaceThreadFixture,
} from "../orchestration-v2/testkit/workspaceFixtures.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceCheckout from "./WorkspaceCheckout.ts";
import * as WorkspaceRepositoryResolver from "./WorkspaceRepositoryResolver.ts";

const layerTest = WorkspaceRepositoryResolver.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "workspace-checkout-" })),
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const root = (id: string, sourcePath: string): ProjectWorkspaceRoot => ({
  id: WorkspaceRootId.make(id),
  alias: id,
  sourcePath,
  description: "",
  defaultSelected: true,
  accessIntent: "write",
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const resolver = yield* WorkspaceRepositoryResolver.WorkspaceRepositoryResolver;
  const temp = yield* fs.makeTempDirectoryScoped({ prefix: "workspace-checkout-" });
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ cwd, args, operation: "WorkspaceCheckout.test" });
  const repositories: Array<string> = [];
  for (const name of ["frontend", "backend"]) {
    const cwd = path.join(temp, name);
    yield* fs.makeDirectory(path.join(cwd, "src"), { recursive: true });
    yield* fs.writeFileString(path.join(cwd, "src", "file.txt"), "fixture");
    yield* run(cwd, ["init", "-b", "main"]);
    yield* run(cwd, ["add", "."]);
    yield* run(cwd, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "initial",
    ]);
    repositories.push((yield* resolver.inspect(cwd)).checkoutRoot);
  }
  return { path, run, resolver, temp, frontend: repositories[0]!, backend: repositories[1]! };
});

const harness = Effect.fn("WorkspaceCheckout.test.harness")(function* (
  thread: OrchestrationV2AppThread,
  projectRoot: string,
) {
  const projection = yield* Ref.make(
    emptyProjection({
      type: "thread.created",
      id: EventId.make("created"),
      threadId: thread.id,
      occurredAt: thread.createdAt,
      payload: thread,
    }),
  );
  const detached = yield* Ref.make<Array<ProviderSessionId>>([]);
  const refreshed = yield* Ref.make<Array<string>>([]);
  const project: Project = {
    id: thread.projectId,
    title: "Checkout fixture",
    workspaceRoot: projectRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-28T00:00:00Z",
    updatedAt: "2026-10-28T00:00:00Z",
    deletedAt: null,
  };
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeedSome(project),
    }),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      detach: ({ providerSessionId }) => Ref.update(detached, (ids) => [...ids, providerSessionId]),
    }),
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
      refreshLocalStatus: (cwd) =>
        Ref.update(refreshed, (paths) => [...paths, cwd]).pipe(
          Effect.as({
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: false,
            refName: null,
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          }),
        ),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: () => Ref.get(projection),
      dispatch: (command) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(projection);
          if (command.type === "provider-session.detach") {
            yield* Ref.set(projection, {
              ...current,
              providerSessions: current.providerSessions.filter(
                (session) => session.id !== command.providerSessionId,
              ),
            });
          } else if (command.type === "thread.workspace.bind") {
            const next = planWorkspaceBinding({
              command,
              projection: current,
              now: thread.updatedAt,
            });
            assert.isTrue(Result.isSuccess(next));
            yield* Ref.set(projection, { ...current, thread: Result.getOrThrow(next) });
          } else if (command.type === "thread.metadata.update") {
            assert.equal(command.expectedWorktreePath, current.thread.worktreePath);
            yield* Ref.set(projection, {
              ...current,
              thread: {
                ...current.thread,
                ...(command.branch === undefined ? {} : { branch: command.branch }),
                ...(command.worktreePath === undefined
                  ? {}
                  : { worktreePath: command.worktreePath }),
              },
            });
          } else return yield* Effect.die("unexpected command");
          return { sequence: 1, storedEvents: [] };
        }),
    }),
  );
  return {
    projection,
    detached,
    refreshed,
    layer: WorkspaceCheckout.layer.pipe(Layer.provide(dependencies)),
  };
});

it.live(
  "synchronizes a branch and follows worktrees in either direction for ordinary threads",
  () =>
    Effect.gen(function* () {
      const { frontend, temp, path, run } = yield* fixture;
      const thread = workspaceThreadFixture();
      const { projection, refreshed, layer } = yield* harness(thread, frontend);
      yield* Effect.gen(function* () {
        const checkout = yield* WorkspaceCheckout.WorkspaceCheckout;
        const target = {
          threadId: thread.id,
          expectedWorkspaceRevisionId: null,
          expectedWorktreePath: null,
        };
        yield* run(frontend, ["switch", "-c", "feature/local"]);
        assert.deepEqual(yield* checkout.bind({ ...target, cwd: path.join(frontend, "src") }), {
          branch: "feature/local",
          worktreePath: null,
        });
        assert.equal((yield* Ref.get(projection)).thread.branch, "feature/local");
        const worktree = path.join(temp, "task");
        yield* run(frontend, ["worktree", "add", "-b", "feature/task", worktree]);
        const bound = yield* checkout.bind({ ...target, cwd: worktree });
        assert.equal(bound.branch, "feature/task");
        assert.equal((yield* Ref.get(projection)).thread.worktreePath, bound.worktreePath);
        yield* checkout.bind({
          ...target,
          cwd: frontend,
          expectedWorktreePath: bound.worktreePath,
        });
        assert.isNull((yield* Ref.get(projection)).thread.worktreePath);
        assert.equal((yield* Ref.get(projection)).thread.branch, "feature/local");
        assert.lengthOf(yield* Ref.get(refreshed), 3);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.live(
  "rebinds primary and secondary group resources while preserving subfolders and unrelated roots",
  () =>
    Effect.gen(function* () {
      const { frontend, backend, temp, path, run, resolver } = yield* fixture;
      const config = {
        primaryRootId: WorkspaceRootId.make("frontend"),
        roots: [
          root("frontend", frontend),
          root("source", path.join(frontend, "src")),
          root("backend", backend),
        ],
      };
      const resolved = yield* resolver.resolve(config);
      const workspace = workspaceFixture({
        ...resolved,
        mode: "existing",
        bindings: resolved.bindings.map((binding) => ({ ...binding, launchBranch: "main" })),
      });
      const thread = { ...workspaceThreadFixture(workspace), branch: "main" };
      const { projection, detached, layer } = yield* harness(thread, frontend);
      const sessionId = ProviderSessionId.make("session");
      yield* Ref.update(projection, (current) => ({
        ...current,
        providerSessions: [
          {
            id: sessionId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: thread.providerInstanceId,
            status: "ready" as const,
            cwd: frontend,
            model: "test",
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            lastError: null,
          },
        ],
      }));
      yield* Effect.gen(function* () {
        const checkout = yield* WorkspaceCheckout.WorkspaceCheckout;
        const target = {
          threadId: thread.id,
          cwd: frontend,
          expectedWorkspaceRevisionId: workspace.id,
          expectedWorktreePath: thread.worktreePath,
        };
        assert.include((yield* checkout.bind(target).pipe(Effect.flip)).message, "Select");
        assert.include(
          (yield* checkout
            .bind({ ...target, cwd: backend, resourceId: workspace.resources[0]!.id })
            .pipe(Effect.flip)).message,
          "another repository",
        );
        for (const index of [0, 1]) {
          const before = (yield* Ref.get(projection)).thread;
          const previous = before.workspace!;
          const selected = previous.resources[index]!;
          const worktree = path.join(temp, `task-${index}`);
          yield* run(selected.checkoutRoot, [
            "worktree",
            "add",
            "-b",
            `feature/${index}`,
            worktree,
          ]);
          yield* checkout.bind({
            threadId: thread.id,
            cwd: worktree,
            resourceId: selected.id,
            expectedWorkspaceRevisionId: previous.id,
            expectedWorktreePath: before.worktreePath,
          });
          const after = (yield* Ref.get(projection)).thread;
          const revision = after.workspace!;
          assert.notEqual(revision.id, previous.id);
          assert.equal(revision.previousRevisionId, previous.id);
          assert.deepEqual(revision.resources[1 - index], previous.resources[1 - index]);
          assert.equal(revision.resources[index]?.ownership, "borrowed");
          assert.notEqual(revision.resources[index]?.id, selected.id);
          for (const binding of previous.bindings) {
            const updated = revision.bindings.find((item) => item.rootId === binding.rootId)!;
            assert.equal(updated.sourcePathAtBind, binding.sourcePathAtBind);
            assert.equal(
              updated.executionPath,
              binding.resourceId === selected.id
                ? path.join(revision.resources[index]!.checkoutRoot, binding.relativeSubpath)
                : binding.executionPath,
            );
          }
          assert.equal(after.branch, index === 0 ? "feature/0" : "feature/renamed");
          assert.equal(after.worktreePath, revision.resources[0]?.checkoutRoot);
          if (index === 0) {
            const primary = revision.resources[0]!;
            yield* run(primary.checkoutRoot, ["switch", "-c", "feature/renamed"]);
            yield* checkout.bind({
              threadId: thread.id,
              cwd: primary.checkoutRoot,
              resourceId: primary.id,
              expectedWorkspaceRevisionId: revision.id,
              expectedWorktreePath: after.worktreePath,
            });
            assert.equal((yield* Ref.get(projection)).thread.branch, "feature/renamed");
            assert.deepEqual((yield* Ref.get(projection)).thread.workspace, revision);
          }
        }
        assert.deepEqual(yield* Ref.get(detached), [sessionId]);
        const before = (yield* Ref.get(projection)).thread;
        const primary = before.workspace!.resources[0]!;
        yield* checkout.bind({
          threadId: thread.id,
          cwd: frontend,
          resourceId: primary.id,
          expectedWorkspaceRevisionId: before.workspace!.id,
          expectedWorktreePath: before.worktreePath,
        });
        const after = (yield* Ref.get(projection)).thread;
        assert.equal(after.branch, "main");
        assert.isNull(after.worktreePath);
        assert.equal(after.workspace?.mode, "existing");
        assert.deepEqual(after.workspace?.resources[1], before.workspace?.resources[1]);
        assert.deepEqual(yield* Ref.get(detached), [sessionId]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.live("rejects stale bindings, unrelated repositories, queued runs, and pending requests", () =>
  Effect.gen(function* () {
    const { frontend, backend, temp, path, run } = yield* fixture;
    const thread = workspaceThreadFixture();
    const { projection, detached, layer } = yield* harness(thread, frontend);
    const worktree = path.join(temp, "task");
    yield* run(frontend, ["worktree", "add", "-b", "feature/task", worktree]);
    yield* Effect.gen(function* () {
      const checkout = yield* WorkspaceCheckout.WorkspaceCheckout;
      const target = {
        threadId: thread.id,
        cwd: worktree,
        expectedWorkspaceRevisionId: null,
        expectedWorktreePath: null,
      };
      for (const input of [
        { ...target, expectedWorktreePath: "/stale" },
        { ...target, expectedWorkspaceRevisionId: WorkspaceRevisionId.make("stale") },
        { ...target, cwd: backend },
      ])
        assert.equal(
          (yield* checkout.bind(input).pipe(Effect.flip))._tag,
          "WorkspaceCheckoutError",
        );
      const original = yield* Ref.get(projection);
      yield* Ref.set(projection, {
        ...original,
        runs: [
          {
            id: RunId.make("queued"),
            threadId: thread.id,
            ordinal: 1,
            providerInstanceId: thread.providerInstanceId,
            modelSelection: thread.modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "queued",
            requestedAt: thread.createdAt,
            startedAt: null,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
      });
      assert.include((yield* checkout.bind(target).pipe(Effect.flip)).message, "Stop");
      yield* Ref.set(projection, {
        ...original,
        runtimeRequests: [
          {
            id: RuntimeRequestId.make("pending"),
            nodeId: NodeId.make("node"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: thread.createdAt,
            resolvedAt: null,
          },
        ],
      });
      assert.include((yield* checkout.bind(target).pipe(Effect.flip)).message, "Stop");
      assert.deepEqual((yield* Ref.get(projection)).thread, thread);
      assert.isEmpty(yield* Ref.get(detached));
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

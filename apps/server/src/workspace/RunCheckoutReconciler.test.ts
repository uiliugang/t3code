import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  NodeId,
  RunId,
  TurnItemId,
  WorkspaceRevisionId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type WorkspaceCheckoutIdentity,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import {
  emptyProjection,
  ProjectionStoreV2,
  threadShellFromProjection,
} from "../orchestration-v2/ProjectionStore.ts";
import {
  workspaceFixture,
  workspaceThreadFixture,
} from "../orchestration-v2/testkit/workspaceFixtures.ts";
import * as RunCheckoutReconciler from "./RunCheckoutReconciler.ts";
import { WorkspaceCheckout } from "./WorkspaceCheckout.ts";
import {
  WorkspaceRepositoryError,
  WorkspaceRepositoryResolver,
} from "./WorkspaceRepositoryResolver.ts";

it.effect.each([
  "ordinary",
  "group",
  "shared-repository",
  "branch-only",
  "changed-checkout",
  "changed-group",
  "newer-run",
] as const)(
  "reconciles successful root Git commands without overriding independent changes (%s)",
  (scenario) =>
    Effect.gen(function* () {
      const baseWorkspace = workspaceFixture();
      const workspace = ["group", "changed-group", "shared-repository"].includes(scenario)
        ? {
            ...baseWorkspace,
            resources: baseWorkspace.resources.map((resource) =>
              scenario === "shared-repository"
                ? {
                    ...resource,
                    identity: {
                      ...resource.identity,
                      commonDir: baseWorkspace.resources[0]!.identity.commonDir,
                      commonDirIdentity: baseWorkspace.resources[0]!.identity.commonDirIdentity,
                    },
                  }
                : resource,
            ),
          }
        : undefined;
      const source = workspace?.resources[0]!.checkoutRoot ?? "/repo";
      const thread = {
        ...workspaceThreadFixture(workspace),
        projectWorkspaceRoot: "/repo",
        worktreePath: workspace ? source : null,
      };
      const run: OrchestrationV2Run = {
        id: RunId.make("run"),
        threadId: thread.id,
        ordinal: 1,
        providerInstanceId: thread.providerInstanceId,
        modelSelection: thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message"),
        rootNodeId: NodeId.make("root"),
        activeAttemptId: null,
        status: "completed",
        requestedAt: thread.createdAt,
        startedAt: thread.createdAt,
        completedAt: thread.updatedAt,
        checkpointId: null,
        contextHandoffId: null,
      };
      const node = (
        id: string,
        kind: OrchestrationV2ExecutionNode["kind"],
        parent: string | null,
      ): OrchestrationV2ExecutionNode => ({
        id: NodeId.make(id),
        threadId: thread.id,
        runId: run.id,
        parentNodeId: parent === null ? null : NodeId.make(parent),
        rootNodeId: run.rootNodeId!,
        kind,
        status: "completed",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: thread.createdAt,
        completedAt: thread.updatedAt,
      });
      const command = (
        ordinal: number,
        input: string,
        overrides: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = {},
      ): OrchestrationV2TurnItem => ({
        id: TurnItemId.make(`command:${ordinal}`),
        threadId: thread.id,
        runId: run.id,
        nodeId: NodeId.make("command"),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: null,
        startedAt: thread.createdAt,
        completedAt: thread.updatedAt,
        updatedAt: thread.updatedAt,
        type: "command_execution",
        input,
        exitCode: 0,
        ...overrides,
      });
      const initial = emptyProjection({
        type: "thread.created",
        id: EventId.make("created"),
        threadId: thread.id,
        occurredAt: thread.createdAt,
        payload: thread,
      });
      const projection = yield* Ref.make({
        ...initial,
        runs: [run],
        nodes: [
          node("root", "root_turn", null),
          node("command", "tool_call", "root"),
          node("agent", "subagent", "root"),
          node("child-command", "tool_call", "agent"),
        ],
        turnItems: [
          command(1, "git worktree add -b feature/first /new-first"),
          command(2, "git worktree add -b feature/latest /new-latest", { cwd: source }),
          command(3, "git worktree add /failed", { exitCode: 1 }),
          command(4, "git worktree add /failed", { outputIndicatesFailure: true }),
          command(5, "git worktree add /failed", { status: "failed" }),
          command(6, "git worktree add /child", { nodeId: NodeId.make("child-command") }),
          command(7, "git -C /unrelated worktree add /unrelated-new"),
          ...(workspace
            ? [
                command(8, "git worktree add -b feature/backend /new-backend", {
                  cwd: "/tasks/backend",
                }),
              ]
            : []),
          ...(scenario === "shared-repository"
            ? [command(9, "git -C /new-latest worktree add /chain")]
            : []),
        ],
      });
      const ordinaryIdentity: WorkspaceCheckoutIdentity = {
        checkoutRoot: source,
        gitDir: `${source}/.git`,
        commonDir: `${source}/.git`,
        gitDirIdentity: "root",
        commonDirIdentity: "root-common",
      };
      const primary = workspace?.resources[0]?.identity ?? ordinaryIdentity;
      const secondary = workspace?.resources[1]?.identity;
      const identities = new Map<string, WorkspaceCheckoutIdentity>([
        [source, primary],
        [
          "/new-first",
          {
            ...primary,
            checkoutRoot: "/new-first",
            gitDir: "/new-first/.git",
            gitDirIdentity: "first",
          },
        ],
        [
          "/new-latest",
          {
            ...primary,
            checkoutRoot: "/new-latest",
            gitDir: "/new-latest/.git",
            gitDirIdentity: "latest",
          },
        ],
        [
          "/unrelated",
          { ...ordinaryIdentity, checkoutRoot: "/unrelated", commonDir: "/unrelated/.git" },
        ],
        [
          "/chain",
          { ...primary, checkoutRoot: "/chain", gitDir: "/chain/.git", gitDirIdentity: "chain" },
        ],
        ...(secondary
          ? [
              [secondary.checkoutRoot, secondary] as const,
              [
                "/new-backend",
                {
                  ...secondary,
                  checkoutRoot: "/new-backend",
                  gitDir: "/new-backend/.git",
                  gitDirIdentity: "new-backend",
                },
              ] as const,
            ]
          : []),
      ]);
      if (scenario === "changed-checkout")
        yield* Ref.update(projection, (current) => ({
          ...current,
          thread: { ...current.thread, worktreePath: "/independent" },
        }));
      if (scenario === "newer-run")
        yield* Ref.update(projection, (current) => ({
          ...current,
          runs: [...current.runs, { ...run, id: RunId.make("newer"), ordinal: 2 }],
        }));
      if (scenario === "changed-group")
        yield* Ref.update(projection, (current) => ({
          ...current,
          thread: {
            ...current.thread,
            workspace: { ...workspace!, id: WorkspaceRevisionId.make("independent") },
          },
        }));
      if (scenario === "branch-only")
        yield* Ref.update(projection, (current) => ({
          ...current,
          turnItems: [command(1, "node switch-branch.js")],
        }));
      const layer = RunCheckoutReconciler.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStoreV2)({
              getThreadRecords: () => Ref.get(projection),
              getThreadShell: () => Ref.get(projection).pipe(Effect.map(threadShellFromProjection)),
            }),
            Layer.mock(WorkspaceRepositoryResolver)({
              inspect: (cwd) =>
                identities.has(cwd)
                  ? Effect.succeed(identities.get(cwd)!)
                  : Effect.fail(
                      new WorkspaceRepositoryError({
                        path: cwd,
                        operation: "inspect",
                        cause: "unknown checkout",
                      }),
                    ),
            }),
            Layer.mock(WorkspaceCheckout)({
              bind: (input) =>
                Effect.gen(function* () {
                  const current = yield* Ref.get(projection);
                  assert.equal(input.expectedWorktreePath, current.thread.worktreePath);
                  assert.equal(
                    input.expectedWorkspaceRevisionId,
                    current.thread.workspace?.id ?? null,
                  );
                  const previous = current.thread.workspace;
                  if (previous) {
                    const revision = {
                      ...previous,
                      id: WorkspaceRevisionId.make(`${previous.id}:next`),
                      previousRevisionId: previous.id,
                      resources: previous.resources.map((resource) =>
                        resource.id === input.resourceId
                          ? {
                              ...resource,
                              checkoutRoot: input.cwd,
                              identity: identities.get(input.cwd)!,
                            }
                          : resource,
                      ),
                    };
                    yield* Ref.set(projection, {
                      ...current,
                      thread: {
                        ...current.thread,
                        workspace: revision,
                        worktreePath: revision.resources[0]!.checkoutRoot,
                      },
                    });
                  } else
                    yield* Ref.set(projection, {
                      ...current,
                      thread: {
                        ...current.thread,
                        worktreePath: input.cwd === source ? null : input.cwd,
                        branch: "feature/actual",
                      },
                    });
                  return { branch: "feature/actual", worktreePath: input.cwd };
                }),
            }),
          ),
        ),
      );
      const refreshed = yield* Effect.gen(function* () {
        const reconciler = yield* RunCheckoutReconciler.RunCheckoutReconciler;
        return yield* reconciler.reconcile({
          threadId: thread.id,
          runId: run.id,
          scope: {
            runId: run.id,
            kind: "root_run",
            cwd: source,
            ...(workspace ? { workspace } : {}),
          },
        });
      }).pipe(Effect.provide(layer));
      const after = (yield* Ref.get(projection)).thread;
      if (scenario === "group" || scenario === "shared-repository") {
        const expectedPaths = [
          scenario === "shared-repository" ? "/chain" : "/new-latest",
          "/new-backend",
        ];
        assert.deepEqual(
          after.workspace?.resources.map((resource) => resource.checkoutRoot),
          expectedPaths,
        );
        assert.sameMembers([...refreshed], expectedPaths);
      } else if (scenario === "ordinary") {
        assert.equal(after.worktreePath, "/new-latest");
        assert.equal(after.branch, "feature/actual");
        assert.deepEqual(refreshed, ["/new-latest"]);
      } else {
        assert.equal(
          after.worktreePath,
          scenario === "changed-checkout"
            ? "/independent"
            : scenario === "changed-group"
              ? source
              : null,
        );
        if (scenario === "branch-only") assert.equal(after.branch, "feature/actual");
        assert.isEmpty(refreshed);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

import { AuthOrchestrationOperateScope, AuthSourceControlWriteScope } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  primaryScopes: new Set<string>(),
  branch: "main",
  grouped: false,
  worktrees: [] as string[],
  thread: {
    id: "thread",
    environmentId: "environment",
    branch: "main",
    worktreePath: null as string | null,
    runtime: null as { status: "queued" | "running" } | null,
    source: { pendingRuntimeRequest: null as { id: string } | null },
  },
  commits: 0,
  pushes: 0,
  switches: 0,
  checkoutRequests: [] as {
    environmentId: string;
    input: {
      threadId: string;
      cwd: string;
      expectedWorktreePath: string | null;
      expectedWorkspaceRevisionId: string | null;
      resourceId?: string;
    };
  }[],
  boundCheckout: null as { branch: string; worktreePath: string | null } | null,
  results: [] as { type: string; description?: string }[],
  afterGitAction: undefined as (() => void) | undefined,
  statusRefreshes: 0,
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomMount: () => {},
  useAtomValue: (atom: unknown) => atom,
}));
vi.mock("./session", () => ({
  useEnvironmentScope: (environmentId: unknown, scope: string) =>
    (environmentId === state.thread.environmentId ? state.scopes : state.primaryScopes).has(scope),
  readEnvironmentScope: (environmentId: unknown, scope: string) =>
    (environmentId === state.thread.environmentId ? state.scopes : state.primaryScopes).has(scope),
}));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: state.thread,
    selectedThreadProject: { workspaceRoot: "/repo" },
  }),
}));
vi.mock("./use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({
    selectedThreadCwd: state.grouped ? "/secondary-repo" : "/repo",
    selectedThreadWorktreePath: state.grouped ? "/secondary-repo" : null,
    ...(state.grouped
      ? {
          repositoryTarget: {
            threadId: state.thread.id,
            workspaceRevisionId: "revision",
            resourceId: "secondary-resource",
          },
        }
      : {}),
  }),
}));
vi.mock("./queries", () => ({
  useBranches: () => ({ data: { refs: [] }, refresh: () => {} }),
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./use-remote-environment-registry", () => ({
  environmentConnectedAtom: () => null,
  setPendingConnectionError: () => {},
}));
vi.mock("./use-vcs-action-state", () => ({
  showGitActionResult: (result: { type: string; description?: string }) =>
    state.results.push(result),
}));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "action" }));
vi.mock("./server", () => ({
  serverEnvironment: {
    workspaceCheckout: Object.assign(
      async (request: (typeof state.checkoutRequests)[number]) => {
        state.checkoutRequests.push(request);
        if (!state.scopes.has(AuthOrchestrationOperateScope)) {
          return AsyncResult.failure(Cause.fail(new Error("Task operation denied")));
        }
        state.boundCheckout = {
          branch: state.branch,
          worktreePath: request.input.cwd === "/repo" ? null : request.input.cwd,
        };
        if (!state.grouped) Object.assign(state.thread, state.boundCheckout);
        return AsyncResult.success(state.boundCheckout);
      },
      { permissionAtom: () => state.scopes.has(AuthOrchestrationOperateScope) },
    ),
  },
}));
vi.mock("./vcs", () => ({
  vcsEnvironment: {
    refreshStatus: async () => {
      state.statusRefreshes += 1;
      return AsyncResult.success({ refName: state.branch });
    },
    switchRef: async ({ input }: { input: { refName: string } }) => {
      state.switches += 1;
      state.branch = input.refName;
      state.afterGitAction?.();
      return AsyncResult.success({ refName: state.branch });
    },
    createRef: async ({ input }: { input: { refName: string } }) => {
      state.branch = input.refName;
      state.afterGitAction?.();
      return AsyncResult.success({ refName: state.branch });
    },
    createWorktree: async ({ input }: { input: { newRefName: string } }) => {
      state.worktrees.push("/repo-worktree");
      state.branch = input.newRefName;
      state.afterGitAction?.();
      return AsyncResult.success({
        worktree: { path: "/repo-worktree", refName: input.newRefName },
      });
    },
    pull: async () => AsyncResult.success({ status: "pulled", refName: state.branch }),
  },
  vcsActionManager: {
    track: (_registry: unknown, _target: unknown, _operation: unknown, run: () => unknown) => run(),
    runStackedAction: () => async (input: { action: string; featureBranch?: boolean }) => {
      if (input.featureBranch) state.branch = "feature";
      if (input.action === "commit") state.commits += 1;
      if (input.action === "push") state.pushes += 1;
      state.afterGitAction?.();
      return AsyncResult.success({
        branch: input.featureBranch
          ? { status: "created", name: "feature" }
          : { status: "skipped_not_requested" },
        toast: { title: "Done", description: "Done", cta: { kind: "none" } },
      });
    },
  },
}));

import { useSelectedThreadGitActions } from "./use-selected-thread-git-actions";

describe("thread Git mutation permissions", () => {
  beforeEach(() => {
    state.scopes = new Set([AuthSourceControlWriteScope]);
    state.primaryScopes = new Set([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
    state.branch = "main";
    state.grouped = false;
    state.worktrees = [];
    state.thread.branch = "main";
    state.thread.worktreePath = null;
    state.thread.runtime = null;
    state.thread.source.pendingRuntimeRequest = null;
    state.commits = 0;
    state.pushes = 0;
    state.switches = 0;
    state.checkoutRequests = [];
    state.boundCheckout = null;
    state.results = [];
    state.afterGitAction = undefined;
    state.statusRefreshes = 0;
  });

  it.each([
    { canOperate: false, grouped: false },
    { canOperate: true, grouped: false },
    { canOperate: false, grouped: true },
    { canOperate: true, grouped: true },
  ])(
    "requires task permission before creating and attaching a worktree: %j",
    async ({ canOperate, grouped }) => {
      state.grouped = grouped;
      if (grouped) state.thread.worktreePath = "/primary-worktree";
      if (canOperate) state.scopes.add(AuthOrchestrationOperateScope);
      const actions = useSelectedThreadGitActions();
      const result = await actions.onCreateSelectedThreadWorktree({
        baseBranch: "main",
        newBranch: "feature/task",
      });
      expect(result).toEqual(
        canOperate ? { worktree: { path: "/repo-worktree", refName: "feature/task" } } : null,
      );
      expect(state.worktrees).toEqual(canOperate ? ["/repo-worktree"] : []);
      expect(state.boundCheckout).toEqual(
        canOperate ? { branch: "feature/task", worktreePath: "/repo-worktree" } : null,
      );
      expect(state.thread.worktreePath).toBe(
        grouped ? "/primary-worktree" : canOperate ? "/repo-worktree" : null,
      );
      expect(state.thread.branch).toBe(canOperate && !grouped ? "feature/task" : "main");
      if (canOperate) {
        expect(state.checkoutRequests[0]?.input).toEqual({
          threadId: "thread",
          cwd: "/repo-worktree",
          expectedWorktreePath: grouped ? "/primary-worktree" : null,
          expectedWorkspaceRevisionId: grouped ? "revision" : null,
          ...(grouped ? { resourceId: "secondary-resource" } : {}),
        });
      }
    },
  );

  it("keeps ordinary commits and pushes available without task permission", async () => {
    const actions = useSelectedThreadGitActions();
    await actions.onRunSelectedThreadGitAction({ action: "commit" });
    await actions.onRunSelectedThreadGitAction({ action: "push" });
    expect(state.commits).toBe(1);
    expect(state.pushes).toBe(1);
    expect(state.thread.branch).toBe("main");
    expect(state.checkoutRequests).toEqual([]);
  });

  it.each(["queued", "running", "pending-request"] as const)(
    "does not mutate Git while the thread has %s work",
    async (status) => {
      state.scopes.add(AuthOrchestrationOperateScope);
      if (status === "pending-request")
        state.thread.source.pendingRuntimeRequest = { id: "request" };
      else state.thread.runtime = { status };
      const actions = useSelectedThreadGitActions();
      expect(actions.canChangeThreadBranch).toBe(false);
      expect(await actions.onCreateSelectedThreadBranch("feature")).toBeNull();
      expect(await actions.onCheckoutSelectedThreadBranch("feature")).toBeNull();
      expect(
        await actions.onCreateSelectedThreadWorktree({ baseBranch: "main", newBranch: "feature" }),
      ).toBeNull();
      expect(state.branch).toBe("main");
      expect(state.worktrees).toEqual([]);
      expect(state.checkoutRequests).toEqual([]);
    },
  );

  it.each(["create", "checkout", "worktree", "commit"] as const)(
    "does not bind the checkout after task permission is revoked during %s",
    async (operation) => {
      state.scopes.add(AuthOrchestrationOperateScope);
      state.afterGitAction = () => state.scopes.delete(AuthOrchestrationOperateScope);
      const actions = useSelectedThreadGitActions();
      if (operation === "create")
        expect(await actions.onCreateSelectedThreadBranch("feature")).toBeNull();
      if (operation === "checkout")
        expect(await actions.onCheckoutSelectedThreadBranch("feature")).toBeNull();
      if (operation === "worktree")
        expect(
          await actions.onCreateSelectedThreadWorktree({
            baseBranch: "main",
            newBranch: "feature",
          }),
        ).toBeNull();
      if (operation === "commit")
        expect(
          await actions.onRunSelectedThreadGitAction({ action: "commit", featureBranch: true }),
        ).toBeNull();
      if (operation === "worktree") expect(state.worktrees).toEqual(["/repo-worktree"]);
      else expect(state.branch).toBe("feature");
      expect(state.thread.branch).toBe("main");
      expect(state.thread.worktreePath).toBeNull();
      expect(state.checkoutRequests).toEqual([]);
      expect(state.results.map((result) => result.type)).toEqual(["error"]);
    },
  );

  it("refreshes the worktree status when binding is denied after checkout", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    state.afterGitAction = () => state.scopes.delete(AuthOrchestrationOperateScope);
    expect(
      await useSelectedThreadGitActions().onCheckoutSelectedThreadBranch("feature"),
    ).toBeNull();
    expect(state.branch).toBe("feature");
    expect(state.statusRefreshes).toBe(1);
  });

  it.each(["create", "checkout", "worktree"] as const)(
    "returns the accepted %s result when only source-control permission is revoked after Git",
    async (operation) => {
      state.scopes.add(AuthOrchestrationOperateScope);
      state.afterGitAction = () => state.scopes.delete(AuthSourceControlWriteScope);
      const actions = useSelectedThreadGitActions();
      const result =
        operation === "create"
          ? await actions.onCreateSelectedThreadBranch("feature/task")
          : operation === "checkout"
            ? await actions.onCheckoutSelectedThreadBranch("feature/task")
            : await actions.onCreateSelectedThreadWorktree({
                baseBranch: "main",
                newBranch: "feature/task",
              });
      expect(result).toEqual(
        operation === "worktree"
          ? { worktree: { path: "/repo-worktree", refName: "feature/task" } }
          : { refName: "feature/task" },
      );
      expect(state.thread.branch).toBe("feature/task");
      expect(state.checkoutRequests).toHaveLength(1);
      expect(state.results).toEqual([]);
    },
  );

  it.each([false, true])(
    "attaches an existing worktree without checking out its occupied branch: %s",
    async (grouped) => {
      state.grouped = grouped;
      state.scopes.add(AuthOrchestrationOperateScope);
      state.branch = "existing";
      const result = await useSelectedThreadGitActions().onCheckoutSelectedThreadBranch(
        "existing",
        "/existing-worktree",
      );
      expect(result).toEqual({ refName: "existing" });
      expect(state.switches).toBe(0);
      expect(state.boundCheckout).toEqual({
        branch: "existing",
        worktreePath: "/existing-worktree",
      });
    },
  );
});

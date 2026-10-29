import { ExecutionResourceId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  atoms: new Map<object, unknown>(),
  thread: {
    id: "thread",
    environmentId: "environment",
    workspace: {
      id: "revision",
      primaryRootId: "primary-root",
      resources: [
        { id: "primary", checkoutRoot: "/primary" },
        { id: "secondary", checkoutRoot: "/secondary" },
      ],
      bindings: [
        { rootId: "primary-root", resourceId: "primary" },
        { rootId: "secondary-root", resourceId: "secondary" },
      ],
    },
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: object) => state.atoms.get(atom) ?? null,
}));
vi.mock("./atom-registry", () => ({
  appAtomRegistry: { set: (atom: object, value: unknown) => state.atoms.set(atom, value) },
}));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: state.thread }),
}));

import { useThreadRepository } from "./use-thread-repository";

it("keeps the selected repository after replacing its checkout and falls back when removed", () => {
  state.atoms.clear();
  useThreadRepository().selectRepository(ExecutionResourceId.make("secondary"));
  expect(useThreadRepository().repository?.checkoutRoot).toBe("/secondary");

  state.thread.workspace = {
    ...state.thread.workspace,
    id: "replacement-revision",
    resources: [
      { id: "primary", checkoutRoot: "/primary" },
      { id: "replacement", checkoutRoot: "/secondary-worktree" },
    ],
    bindings: [
      { rootId: "primary-root", resourceId: "primary" },
      { rootId: "secondary-root", resourceId: "replacement" },
    ],
  };
  expect(useThreadRepository().repository?.checkoutRoot).toBe("/secondary-worktree");
  expect(useThreadRepository().repositoryTarget?.workspaceRevisionId).toBe("replacement-revision");

  state.thread.workspace.bindings = [{ rootId: "primary-root", resourceId: "primary" }];
  state.thread.workspace.resources = [{ id: "primary", checkoutRoot: "/primary" }];
  expect(useThreadRepository().repository?.checkoutRoot).toBe("/primary");
});

import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../test/render";

const state = vi.hoisted(() => ({
  projects: [] as unknown[],
  environments: [] as unknown[],
  permitted: new Set<unknown>(),
  permissionListeners: new Set<() => void>(),
  setPermissions(value: Set<unknown>) {
    this.permitted = value;
    for (const listener of this.permissionListeners) listener();
  },
  create: vi.fn(),
  navigate: vi.fn(),
  setup() {
    this.projects = [];
    this.environments = [];
    this.permitted = new Set();
    this.permissionListeners.clear();
    this.create.mockReset();
    this.navigate.mockReset();
  },
}));
vi.mock(import("../state/entities"), () => ({ useProjects: (() => state.projects) as never }));
vi.mock(import("../state/environments"), () => ({
  useEnvironments: (() => ({ environments: state.environments })) as never,
  usePrimaryEnvironmentId: (() => "local") as never,
}));
vi.mock(import("../state/session"), async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEnvironmentsWithScope: (() =>
      useSyncExternalStore(
        (listener) => {
          state.permissionListeners.add(listener);
          return () => {
            state.permissionListeners.delete(listener);
          };
        },
        () => state.permitted,
      )) as never,
  };
});
vi.mock(import("../state/projects"), () => ({ projectEnvironment: { create: {} } as never }));
vi.mock(import("../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: (() => state.create) as never,
}));
vi.mock(import("../hooks/useHandleNewThread"), () => ({
  useNewThreadHandler: (() => state.navigate) as never,
}));
vi.mock(import("../hooks/useUiTranslation"), () => ({
  useUiTranslation: () => (text: string, values?: Readonly<Record<string, string | number>>) =>
    text.replace(/\{(\w+)\}/g, (match, key: string) => String(values?.[key] ?? match)),
}));

import { CreateWorkspaceDialogHost, openCreateWorkspace } from "./CreateWorkspaceDialog";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
function setup() {
  state.setup();
  state.environments = [local, remote].map((environmentId) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" },
    serverConfig: { environment: { capabilities: { multiRepositoryWorkspaces: true } } },
  }));
  state.permitted = new Set([local, remote]);
  state.projects = ["frontend", "backend"].map((name) => ({
    environmentId: local,
    title: name,
    workspaceRoot: `/code/${name}`,
  }));
}

it("retains the group after a failed save and retries without changing the primary repository", async () => {
  setup();
  state.create
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Directory unavailable"))))
    .mockResolvedValueOnce(AsyncResult.success({}));
  state.navigate.mockResolvedValue(null);
  await using _screen = await render(<CreateWorkspaceDialogHost />);
  await act(() => openCreateWorkspace());
  await page.getByRole("textbox", { name: "Workspace name" }).fill("Product");
  await page.getByRole("combobox", { name: "Choose repository 1" }).click();
  await page.getByRole("option", { name: /frontend/ }).click();
  await page.getByRole("combobox", { name: "Choose repository 2" }).click();
  await page.getByRole("option", { name: /backend/ }).click();
  await page.getByText("Primary repository", { exact: true }).nth(1).click();
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Directory unavailable");
  await expect
    .element(page.getByRole("textbox", { name: "Workspace name" }))
    .toHaveValue("Product");
  await expect.element(page.getByRole("radio").nth(1)).toBeChecked();
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(state.create.mock.calls[1]?.[0]).toEqual(state.create.mock.calls[0]?.[0]);
  expect(state.create.mock.calls[1]?.[0]).toMatchObject({
    environmentId: local,
    input: {
      title: "Product",
      workspaceRoot: "/code/backend",
      workspaceConfig: {
        roots: [{ sourcePath: "/code/frontend" }, { sourcePath: "/code/backend" }],
      },
    },
  });
  expect(state.navigate).toHaveBeenCalledWith(expect.objectContaining({ environmentId: local }), {
    envMode: "worktree",
  });
});

it("clears repository paths on an explicit environment switch and blocks submission after permission loss", async () => {
  setup();
  await using _screen = await render(<CreateWorkspaceDialogHost />);
  await act(() => openCreateWorkspace());
  await page.getByRole("textbox", { name: "Workspace name" }).fill("Local work");
  await page.getByRole("combobox", { name: "Choose repository 1" }).click();
  await page.getByRole("option", { name: /frontend/ }).click();
  await page.getByRole("combobox", { name: "Environment", exact: true }).click();
  await page.getByRole("option", { name: "remote", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Directory on this environment" }).nth(0))
    .toHaveValue("");
  await expect
    .element(page.getByRole("combobox", { name: "Choose repository 1" }))
    .not.toBeInTheDocument();
  await act(() => state.setPermissions(new Set([local])));
  await expect
    .element(page.getByRole("button", { name: "Create workspace", exact: true }))
    .toBeDisabled();
  expect(state.create).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

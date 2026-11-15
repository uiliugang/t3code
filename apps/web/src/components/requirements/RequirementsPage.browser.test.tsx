import "~/index.css";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock(import("~/hooks/useUiTranslation"), () => ({
  useUiTranslation: () => (message: string) => message,
}));
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: () => mocks.command,
}));
vi.mock(
  import("~/state/environments"),
  () =>
    ({
      usePrimaryEnvironmentId: () => "local",
      useEnvironments: () => ({
        environments: ["local", "remote"].map((environmentId) => ({
          environmentId,
          label: environmentId,
          connection: { phase: "connected" },
        })),
      }),
    }) as never,
);
vi.mock(
  import("~/state/entities"),
  () =>
    ({
      useProjects: () =>
        ["local", "remote"].map((environmentId) => ({
          environmentId,
          id: "project",
          title: `${environmentId} project`,
          archivedAt: null,
          isScratch: false,
        })),
    }) as never,
);
vi.mock(import("~/state/server"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    serverEnvironment: {
      configValueAtom: Atom.family(() => Atom.make({ workItems: true, workItemDiscovery: true })),
      mutateWorkItem: { permissionAtom: Atom.family(() => Atom.make(true)) },
      discoverWorkItems: { permissionAtom: Atom.family(() => Atom.make(true)) },
      workItemsLive: Atom.family(({ environmentId }: { environmentId: string }) =>
        Atom.make(
          AsyncResult.success({
            items: [],
            nextCursor: null,
            candidates:
              environmentId === "remote"
                ? [
                    {
                      id: "candidate",
                      projectId: "project",
                      title: "Remote conversation",
                      description: "",
                      status: "idle",
                      updatedAt: "2026-11-15T00:00:00Z",
                    },
                  ]
                : [],
          }),
        ),
      ),
      issueWorkItems: Atom.family(() => Atom.make(new Map())),
    },
  } as never;
});
vi.mock(import("~/state/sourceControl"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    sourceControlEnvironment: {
      issues: Atom.family(() => Atom.make(AsyncResult.success({ groups: [], failures: [] }))),
      createIssue: { permissionAtom: Atom.family(() => Atom.make(true)) },
    },
  } as never;
});
vi.mock(
  import("../work-items/WorkItemsPage"),
  () =>
    ({
      WorkItemEditor: () => null,
      WorkItemDetailPanel: () => null,
    }) as never,
);
vi.mock(import("./IssueCreateDialog"), () => ({ IssueCreateDialog: () => <></> }));
vi.mock(import("./IssueDetailPanel"), () => ({ IssueDetailPanel: () => <></> }));
vi.mock(import("../ui/sidebar"), () => ({ SidebarInset: () => null }) as never);
vi.mock(import("../ui/toast"), () => ({ toastManager: { add: vi.fn() } }) as never);

import { act, render } from "../../../test/render";
import { serverEnvironment } from "~/state/server";
import { RequirementBoard } from "./RequirementsPage";

function setup() {
  mocks.command.mockReset().mockResolvedValue({ _tag: "Success", value: [] });
  const registry = AtomRegistry.make();
  return {
    registry,
    [Symbol.dispose]: () => registry.dispose(),
    board: () => (
      <RegistryContext.Provider value={registry}>
        <RequirementBoard
          environmentId={EnvironmentId.make("local")}
          search={{}}
          updateSearch={() => {}}
        />
      </RegistryContext.Provider>
    ),
  };
}

it("updates remote candidate actions when that environment's grants change", async () => {
  using fixture = setup();
  const permission = serverEnvironment.mutateWorkItem.permissionAtom(
    EnvironmentId.make("remote"),
  ) as Atom.Writable<boolean>;
  fixture.registry.set(permission, false);
  await using screen = await render(fixture.board());
  const add = screen.getByRole("button", { name: "Add task" });
  await expect.element(add).toBeDisabled();
  await act(() => fixture.registry.set(permission, true));
  await expect.element(add).toBeEnabled();
  await act(() => fixture.registry.set(permission, false));
  await expect.element(add).toBeDisabled();
});

it("keeps the scan action locked after its menu closes until the request settles", async () => {
  using fixture = setup();
  let settle!: (result: { _tag: "Success"; value: [] }) => void;
  mocks.command.mockReturnValueOnce(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  await using screen = await render(fixture.board());
  const trigger = screen.getByRole("button", { name: "Scan chats Select a project" });
  try {
    await trigger.click();
    await userEvent.click(page.getByRole("menuitem", { name: "remote", exact: true }));
    await page.getByRole("menuitem", { name: "remote project" }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "remote project" }))
      .not.toBeInTheDocument();
    expect(mocks.command).toHaveBeenCalledExactlyOnceWith({
      environmentId: EnvironmentId.make("remote"),
      input: { projectId: ProjectId.make("project") },
    });
    await expect.element(trigger).toBeDisabled();
  } finally {
    settle({ _tag: "Success", value: [] });
  }
  await expect.element(trigger).toBeEnabled();
});

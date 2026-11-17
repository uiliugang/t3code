import "~/index.css";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock(import("~/hooks/useUiTranslation"), () => ({
  useUiTranslation: () => (message: string) => message,
}));
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: () => mocks.command,
}));
vi.mock(import("~/state/environments"), () => ({
  usePrimaryEnvironmentId: () => "local" as never,
  usePrimaryEnvironment: () => null,
  useEnvironments: () =>
    ({
      environments: ["local", "remote"].map((environmentId) => ({
        environmentId,
        label: environmentId,
        connection: { phase: "connected" },
      })),
    }) as never,
}));
vi.mock(import("~/state/entities"), () => ({
  useProjects: () =>
    ["local", "remote"].map((environmentId) => ({
      environmentId,
      id: "project",
      title: `${environmentId} project`,
      archivedAt: null,
      isScratch: false,
    })) as never,
  useQuietThreadShell: () => null,
  useThreadShells: () => [],
  useServerConfigs: () => new Map(),
  readProjects: () => [],
  readProject: () => null,
  readThreadShell: () => null,
}));
vi.mock(import("~/state/server"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  const workItems = Atom.family((environmentId: string) =>
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
  );
  return {
    primaryServerKeybindingsAtom: Atom.make(compileResolvedKeybindingsConfig([])),
    environmentServerConfigsAtom: Atom.make(new Map()),
    themeServerEnvironmentThemesAtom: Atom.make([]),
    themeServerSettingsAtom: Atom.make(null),
    primaryServerSettingsAtom: Atom.make(null),
    primaryServerConfigAtom: Atom.make(null),
    serverEnvironment: {
      configValueAtom: Atom.family(() => Atom.make({ workItems: true, workItemDiscovery: true })),
      settingsValueAtom: Atom.family(() => Atom.make(null)),
      mutateWorkItem: { permissionAtom: Atom.family(() => Atom.make(true)) },
      discoverWorkItems: { permissionAtom: Atom.family(() => Atom.make(true)) },
      workItemsLive: ({ environmentId }: { environmentId: string }) => workItems(environmentId),
      issueWorkItems: Atom.family(() => Atom.make(new Map())),
    },
  } as never;
});
vi.mock(import("~/state/sourceControl"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const issues = Atom.family((_key: string) =>
    Atom.make(AsyncResult.success({ groups: [], failures: [] })),
  );
  return {
    sourceControlEnvironment: {
      issues: ({ environmentId, input }: { environmentId: string; input: { provider: string } }) =>
        issues(`${environmentId}/${input.provider}`),
      createIssue: { permissionAtom: Atom.family(() => Atom.make(true)) },
    },
  } as never;
});
vi.mock(
  import("../work-items/WorkItemsPage"),
  () =>
    ({
      WorkItemEditor: () => null,
      WorkItemDetailPanel: ({ id }: { id: string }) => (
        <div data-testid={`work-item-detail:${id}`}>Work item {id}</div>
      ),
      ThreadWorkItemsPanel: () => null,
    }) as never,
);
vi.mock(import("./IssueCreateDialog"), () => ({ IssueCreateDialog: () => <></> }));
vi.mock(import("./IssueDetailPanel"), () => ({
  IssueDetailPanel: ({ id }: { id: string }) => (
    <div data-testid={`issue-detail:${id}`}>Issue {id}</div>
  ),
}));
vi.mock(
  import("../pullRequest/PullRequestDetailPanel"),
  () =>
    ({
      PullRequestDetailPanel: () => null,
    }) as never,
);
vi.mock(
  import("../ui/sidebar"),
  () =>
    ({
      SidebarInset: () => null,
      useMobileSidebarSheetMounted: () => false,
    }) as never,
);
vi.mock(import("../ui/toast"), () => ({ toastManager: { add: vi.fn() } }) as never);

import { act, render } from "../../../test/render";
import { REQUIREMENTS_PANEL_REF, useRightPanelStore } from "~/rightPanelStore";
import { serverEnvironment } from "~/state/server";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { RequirementBoard } from "./RequirementsPage";
import type { RequirementsSearch } from "~/routes/_chat.requirements";

function setup() {
  useRightPanelStore.getState().closeAllSurfaces(REQUIREMENTS_PANEL_REF);
  mocks.command.mockReset().mockResolvedValue({ _tag: "Success", value: [] });
  const registry = AtomRegistry.make();
  return {
    registry,
    [Symbol.dispose]: () => registry.dispose(),
    board: (search: RequirementsSearch = {}, updateSearch = vi.fn()) => (
      <RegistryContext.Provider value={registry}>
        <RequirementBoard
          environmentId={EnvironmentId.make("local")}
          search={search}
          updateSearch={updateSearch}
        />
      </RegistryContext.Provider>
    ),
  };
}

it("keeps filter checkmarks in sync with selection and distinguishes projects across environments", async () => {
  using fixture = setup();
  const updateSearch = vi.fn();
  const search: RequirementsSearch = {
    projectId: ProjectId.make("project"),
    archived: true,
    assignee: "selected-user",
  };
  await using screen = await render(fixture.board(search, updateSearch));
  await expect.element(screen.getByText("Remote conversation")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Filters" }).click();
  await expect.element(page.getByRole("menuitemcheckbox", { name: "Show archived" })).toBeChecked();
  await page.getByRole("menuitem", { name: "Project", exact: true }).hover();
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "local · local project" }))
    .toBeChecked();
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "remote · remote project" }))
    .not.toBeChecked();
  await page.getByRole("menuitemcheckbox", { name: "All projects" }).click();
  expect(updateSearch).toHaveBeenLastCalledWith({ projectId: undefined });
  await screen.rerender(fixture.board({ archived: true, assignee: "selected-user" }, updateSearch));
  await expect.element(screen.getByText("Remote conversation")).toBeVisible();
  await expect.element(page.getByRole("menuitemcheckbox", { name: "All projects" })).toBeChecked();
  await userEvent.keyboard("{Escape}");
  await page.getByRole("menuitem", { name: "Assignee", exact: true }).hover();
  await expect.element(page.getByRole("menuitemcheckbox", { name: "selected-user" })).toBeChecked();
  await page.getByRole("menuitemcheckbox", { name: "All assignees" }).click();
  expect(updateSearch).toHaveBeenLastCalledWith({ assignee: "all" });
  await screen.rerender(fixture.board({ assignee: "all", archived: true }, updateSearch));
  await expect.element(page.getByRole("menuitemcheckbox", { name: "All assignees" })).toBeChecked();
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "Assigned to me" }))
    .not.toBeChecked();
  await userEvent.keyboard("{Escape}");
  await page.getByRole("menuitemcheckbox", { name: "Show archived" }).click();
  expect(updateSearch).toHaveBeenLastCalledWith({ archived: false });
  await screen.rerender(fixture.board({ assignee: "all" }, updateSearch));
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "Show archived" }))
    .not.toBeChecked();
});

it("updates remote candidate actions when that environment's grants or capabilities change", async () => {
  using fixture = setup();
  const permission = serverEnvironment.mutateWorkItem.permissionAtom(
    EnvironmentId.make("remote"),
  ) as Atom.Writable<boolean>;
  fixture.registry.set(permission, false);
  await using screen = await render(fixture.board());
  const add = screen.getByRole("button", { name: "Add task" });
  const ignore = screen.getByRole("button", { name: "Ignore" });
  await expect.element(add).toBeDisabled();
  await act(() => fixture.registry.set(permission, true));
  await expect.element(add).toBeEnabled();
  const config = serverEnvironment.configValueAtom(EnvironmentId.make("remote"));
  const { workItemDiscovery: _, ...baseConfig } = fixture.registry.get(config)!;
  for (const unavailable of [false, undefined]) {
    await act(() =>
      fixture.registry.ensureNode(config).setInitialValue({
        ...baseConfig,
        ...(unavailable === undefined ? {} : { workItemDiscovery: unavailable }),
      }),
    );
    await expect.element(ignore).toBeDisabled();
    await expect.element(add).toBeEnabled();
  }
  await act(() =>
    fixture.registry.ensureNode(config).setInitialValue({ ...baseConfig, workItemDiscovery: true }),
  );
  await expect.element(ignore).toBeEnabled();
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

it("keeps compact panel horizontal padding when the main sidebar is collapsed", async () => {
  using fixture = setup();
  document.documentElement.setAttribute("data-sidebar-state", "collapsed");
  try {
    await using screen = await render(
      <RegistryContext.Provider value={fixture.registry}>
        <RequirementBoard
          compact
          environmentId={EnvironmentId.make("local")}
          search={{}}
          updateSearch={vi.fn()}
        />
      </RegistryContext.Provider>,
    );
    const header = screen.container.querySelector("header")!;
    expect(getComputedStyle(header).paddingLeft).toBe("16px");
  } finally {
    document.documentElement.removeAttribute("data-sidebar-state");
  }
});

it("keeps the updating indicator inside the topbar on narrow viewports without vertical wrapping", async () => {
  using fixture = setup();
  const workItemsAtom = serverEnvironment.workItemsLive({
    environmentId: "local",
    input: { archived: false, cursor: undefined },
  } as never) as Atom.Writable<unknown>;
  fixture.registry.set(
    workItemsAtom,
    AsyncResult.success({
      items: [
        {
          id: "item-1",
          projectId: "project",
          title: "Narrow viewport task",
          description: "",
          priority: "P2",
          status: "todo",
          archived: false,
          specRevision: 1,
          version: 1,
          executionCount: 0,
          createdAt: "2026-11-16T00:00:00Z",
          activeExecutionCount: 0,
          updatedAt: "2026-11-16T00:00:00Z",
        },
      ],
      nextCursor: null,
      candidates: [],
    }),
  );
  const issuesAtom = sourceControlEnvironment.issues({
    environmentId: "local",
    input: { provider: "github", assignee: "me", query: "", page: 1 },
  } as never) as Atom.Writable<unknown>;
  fixture.registry.set(issuesAtom, AsyncResult.waiting(AsyncResult.initial()));

  await using screen = await render(
    <div style={{ width: "390px", height: "844px", display: "flex" }}>{fixture.board()}</div>,
  );

  const header = screen.container.querySelector("header")!;
  const status = header.querySelector<HTMLElement>('[role="status"]')!;
  expect(status).not.toBeNull();
  const headerRect = header.getBoundingClientRect();
  const statusRect = status.getBoundingClientRect();
  expect(statusRect.height).toBeLessThanOrEqual(headerRect.height);
  expect(statusRect.top).toBeGreaterThanOrEqual(headerRect.top);
  expect(statusRect.bottom).toBeLessThanOrEqual(headerRect.bottom);

  fixture.registry.set(issuesAtom, AsyncResult.success({ groups: [], failures: [] }));
  fixture.registry.set(
    workItemsAtom,
    AsyncResult.success({ items: [], nextCursor: null, candidates: [] }),
  );
});

it("opens clicked requirement items as peer tabs in the right panel and switches or closes them", async () => {
  using fixture = setup();
  const workItemsAtom = serverEnvironment.workItemsLive({
    environmentId: "local",
    input: { archived: false, cursor: undefined },
  } as never) as Atom.Writable<unknown>;
  const issuesAtom = sourceControlEnvironment.issues({
    environmentId: "local",
    input: { provider: "github", assignee: "me", query: "", page: 1 },
  } as never) as Atom.Writable<unknown>;
  await page.viewport(1280, 800);
  const updateSearch = vi.fn();
  await using screen = await render(
    <div style={{ width: "1280px", height: "800px", display: "flex" }}>
      {fixture.board({}, updateSearch)}
    </div>,
  );
  await act(async () => {
    fixture.registry.set(
      workItemsAtom,
      AsyncResult.success({
        items: [
          {
            id: "item-alpha",
            projectId: "project",
            title: "Alpha requirement",
            description: "",
            priority: "P1",
            status: "todo",
            archived: false,
            specRevision: 1,
            version: 1,
            executionCount: 0,
            createdAt: "2026-11-16T00:00:00Z",
            activeExecutionCount: 0,
            updatedAt: "2026-11-16T00:00:00Z",
          },
          {
            id: "item-beta",
            projectId: "project",
            title: "Beta requirement",
            description: "",
            priority: "P2",
            status: "todo",
            archived: false,
            specRevision: 1,
            version: 1,
            executionCount: 0,
            createdAt: "2026-11-16T00:00:00Z",
            activeExecutionCount: 0,
            updatedAt: "2026-11-16T00:00:00Z",
          },
        ],
        nextCursor: null,
        candidates: [],
      }),
    );
    fixture.registry.set(
      issuesAtom,
      AsyncResult.success({
        groups: [
          {
            source: { provider: "github", host: "github.com", scope: "acme/app" },
            projectIds: ["project"],
            issues: [
              {
                id: "42",
                url: "https://github.com/acme/app/issues/42",
                title: "GitHub bug report",
                state: "open",
                stateCategory: "todo",
                type: "Issue",
                assignees: [],
                priority: "",
                updatedAt: "2026-11-16T00:00:00Z",
              },
            ],
            hasMore: false,
          },
        ],
        failures: [],
      }),
    );
  });

  await screen.getByRole("button", { name: /Alpha requirement/ }).click();
  await expect.element(screen.getByTestId("work-item-detail:item-alpha")).toBeVisible();
  expect(updateSearch).toHaveBeenLastCalledWith(
    expect.objectContaining({ workItemId: "item-alpha" }),
  );

  await screen.getByRole("button", { name: /Beta requirement/ }).click();
  await expect.element(screen.getByTestId("work-item-detail:item-beta")).toBeVisible();

  await screen.getByRole("button", { name: /GitHub bug report/ }).click();
  await expect.element(screen.getByTestId("issue-detail:42")).toBeVisible();

  const tabList = screen.container.querySelector("[data-right-panel-tab-list]")!;
  expect(tabList).not.toBeNull();
  expect(tabList.textContent).toContain("Alpha requirement");
  expect(tabList.textContent).toContain("Beta requirement");
  expect(tabList.textContent).toContain("#42");

  // Switch back to Alpha requirement tab
  await page.getByRole("button", { name: "Alpha requirement", exact: true }).click();
  await expect.element(screen.getByTestId("work-item-detail:item-alpha")).toBeVisible();

  // Close Alpha requirement tab and verify fallback tab stays open
  await page.getByRole("button", { name: "Close Alpha requirement" }).click();
  await expect.element(screen.getByTestId("work-item-detail:item-beta")).toBeVisible();
});

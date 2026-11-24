import "~/index.css";
import { RegistryContext } from "@effect/atom-react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const mocks = vi.hoisted(() => ({ command: vi.fn(), unifiedOnes: false, remoteOnly: false }));
vi.mock(import("~/browser/useOpenLink"), () => ({ useOpenLink: () => vi.fn() }));
vi.mock(import("~/hooks/useUiTranslation"), async () => {
  const { translateUi } = await import("@t3tools/shared/uiLocale");
  return { useUiTranslation: () => translateUi.bind(null, "en") };
});
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: () => mocks.command,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => (mocks.remoteOnly ? null : "local") as never,
  useConnectedEnvironmentIds: () => (mocks.remoteOnly ? ["remote"] : ["local", "remote"]) as never,
  usePrimaryEnvironment: () => null,
  useEnvironments: () =>
    ({
      environments: (mocks.remoteOnly ? ["remote"] : ["local", "remote"]).map((environmentId) => ({
        environmentId,
        label: environmentId,
        connection: { phase: "connected" },
        ...(mocks.unifiedOnes
          ? {
              serverConfig: {
                requirementIssueTrackers: true,
                settings: { meituanIntegrationEnabled: true },
                environment: { capabilities: { issues: true } },
              },
            }
          : {}),
      })),
    }) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
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
  readProjects: () =>
    [
      {
        id: "project",
        environmentId: "local",
        repositoryIdentity: {
          provider: "github",
          canonicalKey: "github.com/acme/app",
          locator: { remoteUrl: "https://github.com/acme/app.git" },
        },
      },
    ] as never,
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
    primaryServerKeybindingsAtom: Atom.make(
      compileResolvedKeybindingsConfig([
        { key: "alt+b", command: "rightPanel.toggle" },
        { key: "alt+w", command: "rightPanel.close" },
      ]),
    ),
    environmentServerConfigsAtom: Atom.make(new Map([["local", {}]])),
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
vi.mock(import("~/state/issues"), async (original) => {
  const actual = await original();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const list = Atom.family((_key: string) =>
    Atom.make(
      AsyncResult.success({
        viewers: {},
        trackers: [],
        entries: [],
        errors: [],
        nextCursors: {},
      }),
    ),
  );
  return {
    ...actual,
    issueEnvironment: {
      ...actual.issueEnvironment,
      list: (({ environmentId }: { environmentId: string }) => list(environmentId)) as never,
      candidates: Atom.family(() =>
        Atom.make(AsyncResult.success({ labels: [], assignees: [], truncated: false })),
      ) as never,
      create: {
        ...actual.issueEnvironment.create,
        permissionAtom: Atom.family(() => Atom.make(true)) as never,
      },
    },
  };
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
      WorkItemDetailPanel: ({ id }: { id: string }) => {
        const open = useOpenChangeRequestLink(undefined, REQUIREMENTS_PANEL_REF);
        const url = "https://github.com/acme/app/pull/7";
        return (
          <div data-testid={`work-item-detail:${id}`}>
            <a
              href={url}
              onClick={(event) => open(event, url, undefined, EnvironmentId.make("local"))}
            >
              Linked PR
            </a>
          </div>
        );
      },
      ThreadWorkItemsPanel: () => null,
    }) as never,
);
vi.mock(import("./IssueCreateDialog"), () => ({
  IssueCreateDialog: () => <></>,
  TrackerCreateDialog: () => <></>,
}));
vi.mock(import("./IssueDetailPanel"), () => ({
  IssueDetailPanel: ({ id, target }: { id: string; target: { url?: string | undefined } }) => (
    <div data-testid={`issue-detail:${id}`} data-issue-url={target.url ?? ""}>
      Issue {id}
    </div>
  ),
}));
vi.mock(import("../issue/IssuesPage"), () => ({
  TrackerIssuesView: () => <div data-testid="tracker-issues-view">Tracker issues</div>,
}));
vi.mock(import("../issue/IssueDetailPanel"), () => ({
  IssueDetailPanel: ({
    environmentId,
    reference,
  }: {
    environmentId: string;
    reference: { key: string; url?: string | undefined };
  }) => (
    <div
      data-testid={`tracker-detail:${reference.key}`}
      data-issue-url={reference.url ?? ""}
      data-environment={environmentId}
    >
      Tracker issue {reference.key}
    </div>
  ),
}));
vi.mock(
  import("../pullRequest/PullRequestDetailPanel"),
  () =>
    ({
      PullRequestDetailPanel: () => <div>Linked PR detail</div>,
    }) as never,
);
vi.mock(
  import("../ui/sidebar"),
  () =>
    ({
      SidebarInset: ({ children }: { children: ReactNode }) => (
        <main className="flex h-dvh">{children}</main>
      ),
      useMobileSidebarSheetMounted: () => false,
    }) as never,
);
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    stackedThreadToast: vi.fn(),
    toastManager: { add: vi.fn() } as unknown as typeof actual.toastManager,
  };
});

import { act, render } from "../../../test/render";
import {
  REQUIREMENTS_PANEL_REF,
  selectActiveRightPanelSurface,
  useRightPanelStore,
} from "~/rightPanelStore";
import { issueEnvironment } from "~/state/issues";
import { serverEnvironment } from "~/state/server";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { RequirementBoard, RequirementsPage } from "./RequirementsPage";
import { Route as requirementsRoute, type RequirementsSearch } from "~/routes/_chat.requirements";
import { useOpenChangeRequestLink } from "~/lib/openPullRequestLink";
import { getWorkspaceFocusRequestVersion, startWorkspaceFocus } from "~/lib/workspaceFocus";

function setup({ unifiedOnes = false } = {}) {
  useRightPanelStore.getState().closeAllSurfaces(REQUIREMENTS_PANEL_REF);
  mocks.unifiedOnes = unifiedOnes;
  mocks.remoteOnly = false;
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

async function openFilterSubmenu(name: string) {
  const trigger = page.getByRole("menuitem", { name, exact: true });
  await expect.element(trigger).toBeVisible();
  await act(() => trigger.element().focus());
  await userEvent.keyboard("{ArrowRight}");
}

it("keeps filter checkmarks in sync with keyboard selection and distinguishes projects across environments", async () => {
  using fixture = setup();
  const updateSearch = vi.fn();
  const search: RequirementsSearch = {
    projectId: ProjectId.make("project"),
    archived: true,
    assignee: "selected-user",
  };
  await using screen = await render(fixture.board(search, updateSearch));
  const discovered = screen.getByRole("heading", { name: "Discovered tasks 1" });
  await expect.element(discovered).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Filters" }).click();
  await expect.element(page.getByRole("menuitemcheckbox", { name: "Show archived" })).toBeChecked();
  await openFilterSubmenu("Project");
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "local · local project" }))
    .toBeChecked();
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "remote · remote project" }))
    .not.toBeChecked();
  const allProjects = page.getByRole("menuitemcheckbox", { name: "All projects" });
  await expect.element(allProjects).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(updateSearch).toHaveBeenLastCalledWith({ projectId: undefined });
  await screen.rerender(
    fixture.board(
      { archived: true, assignee: "selected-user", workflowInvolvement: "assigned" },
      updateSearch,
    ),
  );
  await expect.element(discovered).toBeVisible();
  await expect.element(allProjects).toBeChecked();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("menuitem", { name: "Project", exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  await openFilterSubmenu("Assignee");
  await expect.element(page.getByRole("menuitemcheckbox", { name: "selected-user" })).toBeChecked();
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "Assigned to me" }))
    .toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  const allAssignees = page.getByRole("menuitemcheckbox", { name: "All assignees" });
  await expect.element(allAssignees).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(updateSearch).toHaveBeenLastCalledWith({ assignee: "all", workflowInvolvement: "all" });
  await screen.rerender(fixture.board({ assignee: "all", archived: true }, updateSearch));
  await expect.element(allAssignees).toBeChecked();
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "Assigned to me" }))
    .not.toBeChecked();
  await userEvent.keyboard("{Escape}");
  const assigneeMenu = page.getByRole("menuitem", { name: "Assignee", exact: true });
  await expect.element(assigneeMenu).toHaveAttribute("aria-expanded", "false");
  await expect.element(assigneeMenu).toHaveFocus();
  const showArchived = page.getByRole("menuitemcheckbox", { name: "Show archived" });
  await userEvent.keyboard("{End}");
  await expect.element(showArchived).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(updateSearch).toHaveBeenLastCalledWith({ archived: false });
  await screen.rerender(fixture.board({ assignee: "all" }, updateSearch));
  await expect.element(showArchived).not.toBeChecked();
  await openFilterSubmenu("Issue source");
  await expect.element(page.getByRole("menuitemcheckbox", { name: "All sources" })).toHaveFocus();
  await userEvent.keyboard("{End}");
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "Local work items" }))
    .toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(updateSearch).toHaveBeenLastCalledWith(
    expect.objectContaining({ source: "local", workflowInvolvement: undefined }),
  );
});

it("updates remote candidate actions when that environment's grants or capabilities change", async () => {
  using fixture = setup();
  const permission = serverEnvironment.mutateWorkItem.permissionAtom(
    EnvironmentId.make("remote"),
  ) as Atom.Writable<boolean>;
  fixture.registry.set(permission, false);
  await using screen = await render(fixture.board());
  const discovered = screen.getByRole("button", { name: /Discovered tasks/ });
  const add = screen.getByRole("button", { name: "Add task" });
  const ignore = screen.getByRole("button", { name: "Ignore" });
  await expect.element(discovered).toHaveAttribute("aria-expanded", "false");
  await expect.element(add).not.toBeInTheDocument();
  await discovered.click();
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
  await discovered.click();
  await expect.element(discovered).toHaveAttribute("aria-expanded", "false");
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

it("switches between list and board views with one click, without opening a menu", async () => {
  using fixture = setup();
  const updateSearch = vi.fn();
  await using screen = await render(fixture.board({ view: "list" }, updateSearch));
  await screen.getByRole("button", { name: "Switch to board view" }).click();
  expect(updateSearch).toHaveBeenLastCalledWith({ view: "board" });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await screen.rerender(fixture.board({ view: "board" }, updateSearch));
  await screen.getByRole("button", { name: "Switch to list view" }).click();
  expect(updateSearch).toHaveBeenLastCalledWith({ view: "list" });
  expect(document.querySelector('[role="menu"]')).toBeNull();
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

it("opens a compact workflow issue with its requirement details", async () => {
  using fixture = setup();
  const issuesAtom = sourceControlEnvironment.issues({
    environmentId: "local",
    input: { provider: "github", assignee: "me", query: "", page: 1 },
  } as never) as Atom.Writable<unknown>;
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
              title: "Issue with delivery details",
              url: "https://github.com/acme/app/issues/42",
              state: "Open",
              stateInfo: { category: "open", name: "Open" },
              stateCategory: "todo",
              type: "issue",
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
  await screen.getByRole("button", { name: /Issue with delivery details/ }).click();
  expect(
    selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      REQUIREMENTS_PANEL_REF,
    ),
  ).toMatchObject({
    kind: "requirement-issue",
    issueId: "42",
  });
});

it("preserves Linear workspace URLs in compact thread panels and does not falsely match a rebound workspace row", async () => {
  using fixture = setup({ unifiedOnes: true });
  await page.viewport(1280, 800);
  const threadRef = {
    environmentId: EnvironmentId.make("local"),
    threadId: "thread-1" as import("@t3tools/contracts").ThreadId,
  };
  fixture.registry.set(
    serverEnvironment.configValueAtom("local" as never) as Atom.Writable<unknown>,
    {
      workItems: true,
      workItemDiscovery: true,
      requirementIssueTrackers: true,
      environment: { capabilities: { issues: true } },
    },
  );
  const trackerAtom = issueEnvironment.list({
    environmentId: "local",
    input: { state: "all" },
  } as never) as Atom.Writable<unknown>;
  fixture.registry.set(
    trackerAtom,
    AsyncResult.success({
      viewers: {},
      trackers: [
        {
          tracker: "linear",
          host: "linear.app",
          projectCount: 1,
          capabilities: {
            create: true,
            edit: true,
            comment: true,
            labels: true,
            assignees: true,
            reactions: true,
            templates: true,
            linkedPullRequests: true,
            events: true,
            search: true,
          },
          configured: true,
          detail: null,
        },
      ],
      entries: [
        {
          projectId: "project",
          projectTitle: "Project",
          tracker: "linear",
          host: "linear.app",
          scope: "ENG",
          key: "ENG-1",
          displayKey: "ENG-1",
          title: "Globex ENG-1",
          url: "https://linear.app/globex/issue/ENG-1/globex",
          author: null,
          state: { category: "open", name: "Todo" },
          createdAt: "2026-11-16T00:00:00Z",
          updatedAt: "2026-11-16T00:00:00Z",
          closedAt: null,
          assignees: [],
          labels: [],
          commentCount: 0,
        },
      ],
      errors: [],
      nextCursors: {},
      scopes: [{ projectId: "project", tracker: "linear", host: "linear.app", scope: "ENG" }],
    }),
  );

  // Saved Acme ENG-1 tab on the full Requirements board must not highlight Globex ENG-1 as selected.
  useRightPanelStore.getState().openIssue(REQUIREMENTS_PANEL_REF, {
    environmentId: "local",
    projectId: "project",
    tracker: "linear",
    host: "linear.app",
    scope: "ENG",
    key: "ENG-1",
    url: "https://linear.app/acme/issue/ENG-1/acme",
  });
  await using boardScreen = await render(
    fixture.board({
      assignee: "all",
      detailEnvironmentId: EnvironmentId.make("local"),
      issueId: "ENG-1",
      issueProjectId: "project" as import("@t3tools/contracts").ProjectId,
      issueTracker: "linear",
      issueHost: "linear.app",
      issueScope: "ENG",
      issueUrl: "https://linear.app/acme/issue/ENG-1/acme",
    }),
  );
  await expect
    .element(boardScreen.getByRole("button", { name: /Globex ENG-1/ }))
    .not.toHaveAttribute("aria-current", "true");

  // Clicking Globex ENG-1 in the compact thread Requirements panel must keep its Linear workspace URL.
  await using compactScreen = await render(
    <RegistryContext.Provider value={fixture.registry}>
      <RequirementBoard
        compact
        panelRef={threadRef}
        environmentId={EnvironmentId.make("local")}
        search={{ assignee: "all" }}
        updateSearch={vi.fn()}
      />
    </RegistryContext.Provider>,
  );
  await compactScreen.getByRole("button", { name: /Globex ENG-1/ }).click();
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
  ).toMatchObject({
    url: "https://linear.app/globex/issue/ENG-1/globex",
  });
});

it("starts with to-do issues first and completed issues folded, and reveals full assignee logins on hover", async () => {
  using fixture = setup();
  const issuesAtom = sourceControlEnvironment.issues({
    environmentId: "local",
    input: { provider: "github", assignee: "me", query: "", page: 1 },
  } as never) as Atom.Writable<unknown>;
  fixture.registry.set(
    issuesAtom,
    AsyncResult.success({
      groups: [
        {
          source: { provider: "github", host: "github.com", scope: "acme/app" },
          projectIds: ["project"],
          issues: [
            { id: "1", title: "Unstarted issue", stateCategory: "todo" },
            { id: "2", title: "Active issue", stateCategory: "doing" },
            { id: "3", title: "Finished issue", stateCategory: "done" },
          ].map((issue) => ({
            ...issue,
            url: `https://github.com/acme/app/issues/${issue.id}`,
            state: "Open",
            type: "Issue",
            assignees: [{ value: "lee.product.dev", label: "Lee" }],
            priority: "",
            updatedAt: "2026-11-16T00:00:00Z",
          })),
          hasMore: false,
        },
      ],
      failures: [],
    }),
  );
  const collapseKey = "requirements.collapsed";
  localStorage.removeItem(collapseKey);
  using _storage = { [Symbol.dispose]: () => localStorage.removeItem(collapseKey) };
  await using screen = await render(fixture.board());

  const todo = screen.getByRole("button", { name: /^To do/ });
  const active = screen.getByRole("button", { name: /^In progress/ });
  const done = screen.getByRole("button", { name: /^Completed/ });
  await expect.element(todo).toBeVisible();
  await expect.element(active).toBeVisible();
  expect(todo.element().getBoundingClientRect().top).toBeLessThan(
    active.element().getBoundingClientRect().top,
  );
  await expect.element(done).toHaveAttribute("aria-expanded", "false");
  const finished = screen.getByRole("button", { name: /Finished issue/ });
  await expect.element(finished).not.toBeInTheDocument();

  const row = screen.getByRole("button", { name: /Unstarted issue/ });
  await row.getByLabelText("lee.product.dev").hover();
  await expect.element(page.getByText("lee.product.dev", { exact: true })).toBeVisible();
  await done.click();
  await expect.element(finished).toBeVisible();
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
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const requirements = createRoute({
    getParentRoute: () => chat,
    path: "requirements",
    validateSearch: requirementsRoute.options.validateSearch,
    component: RequirementsPage,
  });
  const history = createMemoryHistory({ initialEntries: ["/requirements?view=list"] });
  const router = createRouter({
    routeTree: root.addChildren([chat.addChildren([requirements])]),
    history,
  });
  await using screen = await render(
    <RegistryContext.Provider value={fixture.registry}>
      <RouterProvider router={router} />
    </RegistryContext.Provider>,
    { router: false }, // The fixture uses the requirements route and its real search validation.
  );
  using _focus = { [Symbol.dispose]: startWorkspaceFocus(router) };
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
        groups: (
          [
            ["github.com", "acme/app", "GitHub bug report"],
            ["github.com", "acme/other", "Other repository issue"],
            ["github.example.com", "acme/app", "Other host issue"],
          ] as const
        ).map(([host, scope, title]) => ({
          source: { provider: "github", host, scope },
          projectIds: ["project"],
          issues: [
            {
              id: "42",
              url: `https://${host}/${scope}/issues/42`,
              title,
              state: "open",
              stateCategory: "todo",
              type: "Issue",
              assignees: [],
              priority: "",
              updatedAt: "2026-11-16T00:00:00Z",
            },
          ],
          hasMore: false,
        })),
        failures: [],
      }),
    );
  });

  const alphaRow = screen.getByRole("button", { name: /Alpha requirement.*P1/ });
  await alphaRow.click();
  await expect.element(screen.getByTestId("work-item-detail:item-alpha")).toBeVisible();
  await expect.element(alphaRow).toHaveFocus();
  expect(router.state.location.search).toMatchObject({ workItemId: "item-alpha", view: "list" });
  await act(() => history.back());
  await expect.element(screen.getByTestId("work-item-detail:item-alpha")).not.toBeInTheDocument();
  await act(() => history.forward());
  await screen.getByRole("link", { name: "Linked PR" }).click();
  await expect.element(screen.getByText("Linked PR detail")).toBeVisible();
  expect(router.state.location.search).toMatchObject({ pullRequest: { number: 7 }, view: "list" });
  const listed = fixture.registry.get(issuesAtom);
  await act(() =>
    fixture.registry.set(
      issuesAtom,
      AsyncResult.waiting(listed as AsyncResult.AsyncResult<unknown>),
    ),
  );
  await expect.element(screen.getByText("Linked PR detail")).toBeVisible();
  await act(() => history.back());
  await expect.element(screen.getByTestId("work-item-detail:item-alpha")).toBeVisible();

  await screen.getByRole("button", { name: /Beta requirement/ }).click();
  await expect.element(screen.getByTestId("work-item-detail:item-beta")).toBeVisible();

  await screen.getByRole("button", { name: /GitHub bug report/ }).click();
  await expect.element(screen.getByTestId("issue-detail:42")).toBeVisible();
  expect(screen.container.querySelectorAll('button[aria-current="true"]')).toHaveLength(1);
  await expect
    .element(screen.getByRole("button", { name: /GitHub bug report/ }))
    .toHaveAttribute("aria-current", "true");

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
  await expect.element(screen.getByText("Linked PR detail")).toBeVisible();
  await userEvent.keyboard("{Alt>}w{/Alt}");
  await expect.element(screen.getByTestId("work-item-detail:item-beta")).toBeVisible();
  const panelToggle = screen.getByRole("button", { name: "Toggle right panel" });
  await act(() => panelToggle.element().focus());
  await userEvent.keyboard("{Enter}");
  await expect.element(panelToggle).toHaveAttribute("aria-pressed", "false");
  await expect.element(panelToggle).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(panelToggle).toHaveAttribute("aria-pressed", "true");
  await expect.element(panelToggle).toHaveFocus();

  const environmentMenu = screen.getByRole("button", { name: "Environment", exact: true });
  await act(() => environmentMenu.element().focus());
  const focusVersion = getWorkspaceFocusRequestVersion();
  await userEvent.keyboard("{Alt>}b{/Alt}");
  await expect.element(panelToggle).toHaveAttribute("aria-pressed", "false");
  await userEvent.keyboard("{Alt>}b{/Alt}");
  await expect.element(panelToggle).toHaveAttribute("aria-pressed", "true");
  expect(getWorkspaceFocusRequestVersion()).toBe(focusVersion);
  await expect.element(environmentMenu).toHaveFocus();

  await page.viewport(600, 800);
  await panelToggle.click();
  await expect.element(screen.getByTestId("work-item-detail:item-beta")).not.toBeInTheDocument();
  await userEvent.keyboard("{Alt>}b{/Alt}");
  await expect.element(screen.getByTestId("work-item-detail:item-beta")).toBeVisible();
  expect(router.state.location.search).toMatchObject({ workItemId: "item-beta", view: "list" });
  await page.viewport(1280, 800);
  await environmentMenu.click();
  await page.getByRole("menuitemcheckbox", { name: "remote", exact: true }).click();
  await expect.element(screen.getByTestId("work-item-detail:item-beta")).not.toBeInTheDocument();
  expect(router.state.location.search).toMatchObject({ environmentId: "remote", view: "list" });
  const query = "q".repeat(200);
  await act(() => router.navigate({ to: "/requirements", search: { q: `${query}overflow` } }));
  await expect
    .element(screen.getByRole("searchbox", { name: "Search title or number" }))
    .toHaveValue(query);
  mocks.remoteOnly = true;
  await act(() =>
    router.navigate({
      to: "/requirements",
      search: {
        mode: "issues",
        detailEnvironmentId: EnvironmentId.make("remote"),
        issueTracker: "linear",
        issueProjectId: ProjectId.make("project"),
        issueScope: "ENG",
        issueId: "ENG-1",
        issueUrl: "https://linear.app/acme/issue/ENG-1",
      },
    }),
  );
  await expect
    .element(screen.getByTestId("tracker-detail:ENG-1"))
    .toHaveAttribute("data-issue-url", "https://linear.app/acme/issue/ENG-1");
  await expect
    .element(screen.getByTestId("tracker-detail:ENG-1"))
    .toHaveAttribute("data-environment", "remote");
  await screen.getByRole("button", { name: "Workflow", exact: true }).click();
  await expect
    .element(screen.getByTestId("tracker-detail:ENG-1"))
    .toHaveAttribute("data-issue-url", "https://linear.app/acme/issue/ENG-1");
});

it.each([
  { selection: { issueTracker: "linear", issueScope: "ENG" }, detail: "tracker-detail:ENG-1" },
  { selection: { issueProvider: "linear", issueScope: "ENG" }, detail: "issue-detail:ENG-1" },
] as const)(
  "does not restore $detail without a Linear workspace URL",
  async ({ selection, detail }) => {
    using fixture = setup();
    const search = {
      ...selection,
      issueProjectId: ProjectId.make("project"),
      issueId: "ENG-1",
    };
    await using screen = await render(
      fixture.board({ ...search, issueUrl: "https://linear.app/acme/issue/ENG-1" }),
    );
    await expect.element(screen.getByTestId(detail)).toBeVisible();

    await screen.rerender(fixture.board(search));
    await expect.element(screen.getByTestId(detail)).not.toBeInTheDocument();

    await screen.rerender(fixture.board({ ...search, issueUrl: "https://linear.app/acme" }));
    await expect.element(screen.getByTestId(detail)).not.toBeInTheDocument();
  },
);

it("switches between workflow and tracker issue modes from the shared requirements page", async () => {
  using fixture = setup();
  const updateSearch = vi.fn();
  await using screen = await render(fixture.board({ mode: "issues" }, updateSearch));
  await expect.element(screen.getByTestId("tracker-issues-view")).toBeVisible();
  const modeSwitch = screen.getByRole("group", { name: "View mode" });
  await expect.element(modeSwitch).toBeVisible();
  await screen.getByRole("button", { name: "Workflow", exact: true }).click();
  expect(updateSearch).toHaveBeenLastCalledWith({ mode: "board" });
  await screen.rerender(fixture.board({ mode: "board" }, updateSearch));
  await expect.element(screen.getByTestId("tracker-issues-view")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Issues", exact: true }).click();
  expect(updateSearch).toHaveBeenLastCalledWith({ mode: "issues" });
});

it("falls back to assigned issues instead of applying unsupported legacy involvement filters", async () => {
  using fixture = setup();
  await using screen = await render(
    fixture.board({ workflowInvolvement: "authored", assignee: "all" }, vi.fn()),
  );
  await screen.getByRole("button", { name: "Filters" }).click();
  await openFilterSubmenu("Involvement");
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "Assigned to me" }))
    .toBeChecked();
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "Opened by me" }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "Mentioning me" }))
    .not.toBeInTheDocument();
});

it("keeps unsupported advanced filters out of an ONES workflow query", async () => {
  using fixture = setup({ unifiedOnes: true });
  await using screen = await render(
    fixture.board({
      source: "meituan",
      assignee: "all",
      workflowInvolvement: "mentioned",
      workflowSort: "created",
    }),
  );
  await screen.getByRole("button", { name: "Filters" }).click();
  await openFilterSubmenu("Involvement");
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "Assigned to me" }))
    .toBeChecked();
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "Mentioning me" }))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("menuitem", { name: "Involvement", exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  await openFilterSubmenu("Sort");
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "Recently updated" }))
    .toBeChecked();
  await expect.element(page.getByRole("menuitemcheckbox", { name: "Newest" })).toBeDisabled();
});

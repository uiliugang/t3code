import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ProjectId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
// The draft route loads ChatView lazily; importing it here keeps its first transform out of the test's timeout.
import "~/components/ChatView";
import { openCommandPalette } from "~/commandPaletteBus";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useUiStateStore } from "~/uiStateStore";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("the new-thread project picker follows the manual sidebar project order", async () => {
  using _environment = installFakeEnvironment([], {
    capabilities: { multiRepositoryWorkspaces: true },
    extraProjects: [
      { id: ProjectId.make("project-alpha"), title: "alpha" },
      { id: ProjectId.make("project-beta"), title: "beta" },
    ],
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    uiLanguage: "en",
    capitalizeProjectNames: false,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    sidebarProjectSortOrder: "manual",
  });
  useUiStateStore.setState({
    projectOrder: [
      `${ENVIRONMENT_ID}:/workspace/beta`,
      `${ENVIRONMENT_ID}:/workspace/render`,
      `${ENVIRONMENT_ID}:/workspace/alpha`,
    ],
  });
  using _order = { [Symbol.dispose]: () => useUiStateStore.setState({ projectOrder: [] }) };
  const draftId = DraftId.make("draft-manual-order");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId);

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  // The shell snapshot has arrived once the sidebar lists the project.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  const trigger = document.querySelector<HTMLElement>("[data-draft-project-trigger]");
  if (!trigger) throw new Error("The draft project picker did not render.");
  await userEvent.click(page.elementLocator(trigger));
  await expect.element(page.getByRole("option", { name: /beta/ })).toBeVisible();

  // The draft's own project leads; the rest keep the sidebar's order.
  await vi.waitFor(() => {
    expect(
      page
        .getByRole("option")
        .elements()
        .map((option) => option.textContent),
    ).toEqual([
      expect.stringMatching(/render$/),
      expect.stringMatching(/beta$/),
      expect.stringMatching(/alpha$/),
      "Add project",
    ]);
  });

  await page.getByRole("checkbox", { name: "Combine with beta", exact: true }).click();
  await expect.element(page.getByRole("combobox", { name: "Search projects" })).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Group name" })).toBeVisible();
  expect(
    useComposerDraftStore.getState().getDraftSession(draftId)?.selectedProjectIds,
  ).toBeUndefined();
  await page.getByRole("textbox", { name: "Group name" }).fill("Client and API");
  await page.getByRole("radio", { name: "beta", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Group name" }))
    .toHaveValue("Client and API");
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...composition,
    });
    page.getByRole("textbox", { name: "Group name" }).element().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  await expect.element(page.getByRole("textbox", { name: "Group name" })).toBeVisible();
  expect(
    useComposerDraftStore.getState().getDraftSession(draftId)?.selectedProjectIds,
  ).toBeUndefined();
  await page.getByRole("textbox", { name: "Group name" }).click();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("textbox", { name: "Group name" })).not.toBeInTheDocument();
  expect(
    useComposerDraftStore.getState().getDraftSession(draftId)?.selectedProjectIds,
  ).toBeUndefined();
  await userEvent.click(page.elementLocator(trigger));
  await expect
    .element(page.getByRole("checkbox", { name: "Combine with beta", exact: true }))
    .not.toBeChecked();
  await page.getByRole("checkbox", { name: "Combine with beta", exact: true }).click();
  await page.getByRole("textbox", { name: "Group name" }).fill("Client and API");
  await page.getByRole("radio", { name: "beta", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await vi.waitFor(() =>
    expect(
      Object.values(useComposerDraftStore.getState().draftThreadsByThreadKey).some(
        (draft) => draft.selectedProjectIds?.length === 2,
      ),
    ).toBe(true),
  );
  const session = Object.values(useComposerDraftStore.getState().draftThreadsByThreadKey).find(
    (draft) => (draft.selectedProjectIds?.length ?? 0) === 2,
  );
  expect(session).toMatchObject({
    selectedProjectIds: ["project-beta", PROJECT_ID],
    envMode: "worktree",
    groupTitle: "Client and API",
  });
});

it("selects multiple repositories in the new-thread command palette before starting a draft", async () => {
  const alphaId = ProjectId.make("project-alpha");
  const repositoryIdentity = {
    canonicalKey: "example.com/team/alpha",
    name: "alpha",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://example.com/team/alpha.git",
    },
  };
  using _environment = installFakeEnvironment([], {
    capabilities: { multiRepositoryWorkspaces: true },
    extraProjects: [
      { id: ProjectId.make("older-alpha"), title: "older-alpha", repositoryIdentity },
      { id: alphaId, title: "alpha", repositoryIdentity },
      { id: ProjectId.make("project-beta"), title: "beta" },
    ],
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    uiLanguage: "en",
    capitalizeProjectNames: false,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-palette-multi-project");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, alphaId), draftId);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("alpha", { exact: true }).first()).toBeVisible();
  openCommandPalette({ open: "new-thread-in" });
  const alpha = page.getByRole("option", { name: /alpha/ });
  const beta = page.getByRole("option", { name: /beta/ });
  await expect.element(page.getByRole("button", { name: "Start (0)", exact: true })).toBeDisabled();
  await expect.element(alpha.getByText("/workspace/alpha", { exact: true })).toBeVisible();
  await alpha.click();
  await expect.element(page.getByRole("combobox")).toBeVisible();
  await expect.element(alpha).toHaveAttribute("aria-checked", "true");
  await expect.element(page.getByRole("button", { name: "Start (1)", exact: true })).toBeEnabled();
  await alpha.click();
  await expect.element(alpha).toHaveAttribute("aria-checked", "false");
  await expect.element(page.getByRole("button", { name: "Start (0)", exact: true })).toBeDisabled();
  await alpha.click();
  await beta.click();
  await expect.element(page.getByRole("button", { name: "Start (2)", exact: true })).toBeEnabled();
  await userEvent.keyboard("{Escape}");
  openCommandPalette({ open: "new-thread-in" });
  await expect.element(alpha).toHaveAttribute("aria-checked", "false");
  await expect.element(beta).toHaveAttribute("aria-checked", "false");
  await alpha.click();
  await page.getByRole("combobox").fill("beta");
  await userEvent.keyboard("{Enter}");
  await expect.element(beta).toHaveAttribute("aria-checked", "true");
  await expect.element(page.getByRole("button", { name: "Start (2)", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Start (2)", exact: true }).click();
  await vi.waitFor(() => {
    expect(
      Object.values(useComposerDraftStore.getState().draftThreadsByThreadKey).some(
        (draft) =>
          draft.selectedProjectIds?.join(",") === "project-alpha,project-beta" &&
          draft.envMode === "worktree",
      ),
    ).toBe(true);
  });
  const trigger = document.querySelector<HTMLElement>("[data-draft-project-trigger]");
  if (!trigger) throw new Error("The draft project picker did not render.");
  await userEvent.click(page.elementLocator(trigger));
  await page.getByRole("checkbox", { name: "Remove alpha from group", exact: true }).click();
  await expect.element(page.getByRole("radio", { name: "beta", exact: true })).toBeChecked();
  expect(page.getByRole("radio").elements()).toHaveLength(1);
});

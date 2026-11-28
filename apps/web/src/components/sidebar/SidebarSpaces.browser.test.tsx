import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { SidebarSpace } from "@t3tools/client-runtime/sidebar-spaces";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { removeLocalStorageItem } from "../../hooks/useLocalStorage";
import appCss from "../../index.css?inline";
import { SidebarProvider } from "../ui/sidebar";
import {
  SidebarSpaceEditor,
  SidebarSpaceFooter,
  SidebarSpacePicker,
  useSidebarSpaces,
} from "./SidebarSpaces";
import {
  readActiveSidebarSpace,
  useActiveSidebarSpace,
  selectActiveSidebarSpace,
  SIDEBAR_SPACE_DEFINITIONS,
} from "./sidebarSpaceSession";

vi.mock(import("../../hooks/useUiTranslation"), async () => {
  const { translateUi } = await import("@t3tools/shared/uiLocale");
  return {
    useUiTranslation: () => (message: string, values?: Record<string, string | number>) =>
      translateUi("en", message, values),
  };
});

const projectId = ProjectId.make("engineering");
const laptop = { environmentId: EnvironmentId.make("laptop"), projectId };
const buildHost = { environmentId: EnvironmentId.make("build-host"), projectId };

function SpacesSidebar() {
  const spaces = useSidebarSpaces();
  const active = useActiveSidebarSpace();
  const [creating, setCreating] = useState(false);
  return (
    <SidebarProvider>
      <div className="w-64">
        <output aria-label="Active Space">{active?.name ?? "All"}</output>
        <SidebarSpacePicker
          spaces={spaces.spaces}
          active={spaces.active}
          onSelect={(space) => spaces.select(space?.id ?? null)}
          onEdit={() => {}}
          onCreate={() => setCreating(true)}
        />
        <SidebarSpaceFooter
          spaces={spaces.spaces}
          active={spaces.active}
          onSelect={(space) => spaces.select(space?.id ?? null)}
          onCreate={() => setCreating(true)}
        />
        {creating ? (
          <SidebarSpaceEditor
            editing={null}
            spaces={spaces.spaces}
            projects={[
              { label: "Engineering · Laptop", ref: laptop },
              { label: "Engineering · Build host", ref: buildHost },
            ]}
            onSave={(space) => {
              spaces.save(space);
              spaces.select(space.id);
              setCreating(false);
            }}
            onRemove={spaces.remove}
            onClose={() => setCreating(false)}
          />
        ) : null}
      </div>
    </SidebarProvider>
  );
}

it("creates a Space from the footer and selects exactly one of two same-ID projects", async () => {
  using cleanup = new DisposableStack();
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  cleanup.defer(() => style.remove());
  cleanup.defer(() => {
    selectActiveSidebarSpace(null);
    removeLocalStorageItem(SIDEBAR_SPACE_DEFINITIONS);
  });
  selectActiveSidebarSpace(null);
  removeLocalStorageItem(SIDEBAR_SPACE_DEFINITIONS);

  await using screen = await render(<SpacesSidebar />);
  await screen.getByRole("button", { name: "New Space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New Space" });
  await expect.element(dialog).toBeVisible();
  await userEvent.fill(dialog.getByRole("textbox", { name: "Space name" }), "Builds");
  await dialog.getByRole("checkbox", { name: "Engineering · Build host" }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  const builds = screen.getByRole("button", { name: "Builds", exact: true });
  await expect.element(builds).toHaveAttribute("aria-pressed", "true");
  await expect
    .element(screen.getByRole("status", { name: "Active Space" }))
    .toHaveTextContent("Builds");
  expect(readActiveSidebarSpace()?.projectRefs).toEqual([buildHost]);

  await screen.getByRole("button", { name: "All projects", exact: true }).click();
  await expect.element(builds).toHaveAttribute("aria-pressed", "false");
  await builds.click();
  await expect.element(builds).toHaveAttribute("aria-pressed", "true");
  expect(readActiveSidebarSpace()?.projectRefs).toEqual([buildHost]);
});

function OverflowSpaces() {
  const spaces = Array.from({ length: 9 }, (_, index) => ({
    id: `space-${index}`,
    name: `Space ${index}`,
    projectRefs: [],
  }));
  const [active, setActive] = useState<SidebarSpace | null>(spaces[8] ?? null);
  return (
    <div className="w-52">
      <SidebarSpaceFooter
        spaces={spaces}
        active={active}
        onSelect={setActive}
        onCreate={() => {}}
      />
    </div>
  );
}

it("keeps the active Space visible and overflow choices reachable by keyboard in a narrow rail", async () => {
  using cleanup = new DisposableStack();
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  cleanup.defer(() => style.remove());
  await using screen = await render(<OverflowSpaces />);
  const current = screen.getByRole("button", { name: "Space 8", exact: true });
  await expect.element(current).toBeVisible();
  await expect.element(current).toHaveAttribute("aria-pressed", "true");
  const more = screen.getByRole("button", { name: "More Spaces", exact: true });
  await more.click();
  const choice = page.getByRole("menuitem", { name: "Space 7", exact: true });
  await expect.element(choice).toBeVisible();
  await choice.click();
  const selected = screen.getByRole("button", { name: "Space 7", exact: true });
  await expect.element(selected).toHaveAttribute("aria-pressed", "true");
  await selected.click();
  await userEvent.tab();
  await expect.element(more).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("menuitem", { name: "Space 8", exact: true })).toBeVisible();
});

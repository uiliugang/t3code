import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { removeLocalStorageItem } from "../../hooks/useLocalStorage";
import { SidebarProvider } from "../ui/sidebar";
import {
  SidebarSpaceEditor,
  SidebarSpaceFooter,
  SidebarSpacePicker,
  useSidebarSpaces,
} from "./SidebarSpaces";
import {
  readActiveSidebarSpace,
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
  const [creating, setCreating] = useState(false);
  return (
    <SidebarProvider>
      <SidebarSpacePicker
        spaces={spaces.spaces}
        active={spaces.active}
        onSelect={(space) => spaces.select(space?.id ?? null)}
        onEdit={() => {}}
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
    </SidebarProvider>
  );
}

it("creates a Space from the footer and selects exactly one of two same-ID projects", async () => {
  using cleanup = new DisposableStack();
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
  expect(readActiveSidebarSpace()?.projectRefs).toEqual([buildHost]);

  await screen.getByRole("button", { name: "All projects", exact: true }).click();
  await expect.element(builds).toHaveAttribute("aria-pressed", "false");
  await builds.click();
  await expect.element(builds).toHaveAttribute("aria-pressed", "true");
  expect(readActiveSidebarSpace()?.projectRefs).toEqual([buildHost]);
});

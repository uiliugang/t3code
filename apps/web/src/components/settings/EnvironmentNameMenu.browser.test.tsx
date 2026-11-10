import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

vi.mock(import("~/state/session"), () => ({ useEnvironmentScope: () => true }));
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: () => async () => {
    throw new Error("Unexpected settings write");
  },
}));
vi.mock(import("~/state/server"), () => ({ serverEnvironment: { updateSettings: {} } as never }));
vi.mock(import("~/hooks/useUiTranslation"), () => ({
  useUiTranslation: () => (message: string) => message,
}));

import { render } from "../../../test/render";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { EnvironmentNameMenu } from "./EnvironmentNameMenu";

it("closes the rename submenu with Escape while editing", async () => {
  const config = {
    settings: DEFAULT_SERVER_SETTINGS,
    environment: { label: "Detected host", capabilities: { environmentName: true } },
  } as Pick<ServerConfig, "environment" | "settings">;
  await using screen = await render(
    <Menu>
      <MenuTrigger>Environment actions</MenuTrigger>
      <MenuPopup>
        <EnvironmentNameMenu environmentId={EnvironmentId.make("desk")} serverConfig={config} />
      </MenuPopup>
    </Menu>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Environment actions" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Rename environment" }));
  const input = page.getByRole("textbox", { name: "Environment name" });
  await userEvent.click(input);
  await userEvent.type(input, "Office server");
  await userEvent.keyboard("{Escape}");
  await expect.element(input).not.toBeInTheDocument();
  await expect.element(page.getByRole("menuitem", { name: "Rename environment" })).toHaveFocus();
});

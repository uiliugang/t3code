import { createContext, useContext } from "react";
import { DEFAULT_CLIENT_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";

vi.mock(import("./SettingsScopeContext"), () => ({
  useSettingsScope: () => useContext(TestScopeContext)!,
  useOptionalSettingsScope: () => useContext(TestScopeContext),
  SettingsScopeProvider: (() => null) as never,
}));

import { ApplicationConfigurationSettings } from "./ConfigurationSettings";

type Scope = ReturnType<typeof import("./SettingsScopeContext").useSettingsScope>;
const TestScopeContext = createContext<Scope | null>(null);

it("switches the transfer environment and recovers when that environment disconnects", async () => {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage: "en" });
  const environments = ["Laptop", "Server"].map((label) => ({
    environmentId: EnvironmentId.make(label),
    label,
    displayUrl: null,
    connection: { phase: "connected" },
    serverConfig: {
      environment: {
        platform: { machine: "desktop" },
        capabilities: { projectConfigurationImport: false },
      },
    },
  })) as Scope["connectedEnvironments"];
  const view = (connectedEnvironments: Scope["connectedEnvironments"]) => (
    <TestScopeContext
      value={{ scope: { kind: "all" }, connectedEnvironments, targets: [] } as unknown as Scope}
    >
      <ApplicationConfigurationSettings />
    </TestScopeContext>
  );
  await using screen = await render(view(environments), { router: "/settings/general" });
  await expect.element(screen.getByRole("button", { name: "Export" })).toBeVisible();
  await screen.getByRole("button", { name: "Environment scope: Laptop" }).click();
  await page.getByRole("menuitemradio", { name: /^Server/ }).click();
  await expect
    .element(screen.getByRole("button", { name: "Environment scope: Server" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("heading", { name: "Environment scope: Server", exact: true }))
    .toBeVisible();
  await screen.rerender(view(environments.slice(0, 1)));
  await expect
    .element(screen.getByRole("button", { name: /^Environment scope:/ }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText("Laptop", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Export" })).toBeVisible();
  await screen.rerender(view([]));
  await expect.element(screen.getByRole("button", { name: "Export" })).not.toBeInTheDocument();
  await expect
    .element(screen.getByText("Choose one connected environment to import or export app settings."))
    .toBeVisible();
});

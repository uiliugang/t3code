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

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: useContext(TestEnvironmentsContext) })) as never,
  usePrimaryEnvironmentId: () => EnvironmentId.make("Laptop"),
  usePrimaryEnvironment: () =>
    useContext(TestEnvironmentsContext).find((environment) => environment.label === "Laptop") ??
    null,
}));

import { ApplicationConfigurationSettings } from "./ConfigurationSettings";

type Scope = ReturnType<typeof import("./SettingsScopeContext").useSettingsScope>;
const TestScopeContext = createContext<Scope | null>(null);
const TestEnvironmentsContext = createContext<Scope["connectedEnvironments"]>([]);

it("switches the transfer environment and recovers when that environment disconnects", async () => {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage: "en" });
  const environments = ["Server", "Laptop"].map((label) => ({
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
  const view = (
    available: Scope["connectedEnvironments"],
    selected: EnvironmentId | null = EnvironmentId.make("Laptop"),
  ) => (
    <TestEnvironmentsContext value={available}>
      <TestScopeContext
        value={
          {
            scope: selected ? { kind: "environment", environmentId: selected } : { kind: "all" },
            connectedEnvironments: available.filter(
              (entry) => selected === null || entry.environmentId === selected,
            ),
            targets: [],
          } as unknown as Scope
        }
      >
        <ApplicationConfigurationSettings />
      </TestScopeContext>
    </TestEnvironmentsContext>
  );
  await using screen = await render(view(environments), { router: "/settings/general" });
  await expect.element(screen.getByRole("button", { name: "Export" })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Environment scope: Laptop" }))
    .toBeVisible();
  await screen.rerender(view(environments, null));
  await expect
    .element(screen.getByRole("button", { name: "Environment scope: Laptop" }))
    .toBeVisible();
  await screen.rerender(view(environments, EnvironmentId.make("Server")));
  await expect
    .element(screen.getByRole("button", { name: "Environment scope: Server" }))
    .toBeVisible();
  await screen.rerender(view(environments));
  await screen.getByRole("button", { name: "Environment scope: Laptop" }).click();
  await page.getByRole("menuitemradio", { name: /^Server/ }).click();
  await expect
    .element(screen.getByRole("button", { name: "Environment scope: Server" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("heading", { name: "Environment scope: Server", exact: true }))
    .toBeVisible();
  await screen.rerender(view([...environments].reverse()));
  await expect
    .element(screen.getByRole("button", { name: "Environment scope: Server" }))
    .toBeVisible();
  await screen.rerender(
    view(
      environments.map((entry) =>
        entry.label === "Server" ? { ...entry, connection: { phase: "disconnected" } } : entry,
      ) as Scope["connectedEnvironments"],
    ),
  );
  await expect
    .element(screen.getByRole("button", { name: /^Environment scope:/ }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText("Laptop", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Export" })).toBeVisible();
  await screen.rerender(
    view(
      environments.map((entry) =>
        entry.label === "Server" ? { ...entry, serverConfig: null } : entry,
      ),
    ),
  );
  await expect
    .element(screen.getByRole("button", { name: /^Environment scope:/ }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText("Laptop", { exact: true })).toBeVisible();
  await screen.rerender(view([]));
  await expect.element(screen.getByRole("button", { name: "Export" })).not.toBeInTheDocument();
  await expect
    .element(screen.getByText("Choose one connected environment to import or export app settings."))
    .toBeVisible();
});

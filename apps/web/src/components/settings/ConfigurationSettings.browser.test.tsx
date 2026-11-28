import { createContext, useContext, useState } from "react";
import { DEFAULT_CLIENT_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import type { SettingsFile } from "@t3tools/client-runtime/settings-transfer";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import type { SettingsScopeSearch } from "./settingsScope";

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
import { SettingsScopeSentence } from "./SettingsScopeSentence";

type Scope = ReturnType<typeof import("./SettingsScopeContext").useSettingsScope>;
const TestScopeContext = createContext<Scope | null>(null);
const TestEnvironmentsContext = createContext<Scope["connectedEnvironments"]>([]);

function TransferHarness({
  available,
  selected,
}: {
  available: Scope["connectedEnvironments"];
  selected: EnvironmentId | null;
}) {
  const [override, setOverride] = useState<SettingsScopeSearch | null>(null);
  const search: SettingsScopeSearch = override ?? (selected ? { machine: selected } : {});
  const activeId = search.machine ? EnvironmentId.make(search.machine) : null;
  return (
    <TestEnvironmentsContext value={available}>
      <TestScopeContext
        value={
          {
            search,
            selectScope: setOverride,
            groups: [],
            singleEnvironment: false,
            scope: activeId ? { kind: "environment", environmentId: activeId } : { kind: "all" },
            connectedEnvironments: available.filter(
              (entry) => activeId === null || entry.environmentId === activeId,
            ),
            targets: [],
          } as unknown as Scope
        }
      >
        <SettingsScopeSentence pathname="/settings/general" />
        <ApplicationConfigurationSettings />
      </TestScopeContext>
    </TestEnvironmentsContext>
  );
}

it("switches the transfer environment from the header and recovers when that environment disconnects", async () => {
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
  ) => <TransferHarness available={available} selected={selected} />;
  await using screen = await render(view(environments), { router: "/settings/general" });
  await expect.element(screen.getByRole("button", { name: "Export" })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Environment scope: Laptop" }))
    .toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Laptop", exact: true })).toBeVisible();
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
  await expect.element(screen.getByRole("heading", { name: "Server", exact: true })).toBeVisible();
  await screen.rerender(view([...environments].reverse()));
  await expect
    .element(screen.getByRole("button", { name: "Environment scope: Server" }))
    .toBeVisible();
  const backup = {
    format: "t3-code-settings",
    version: 1,
    scope: "application",
    clientSettings: {},
    server: {},
    keybindings: [],
    providers: {},
  } satisfies SettingsFile;
  await userEvent.upload(
    screen.container.querySelector<HTMLInputElement>('input[type="file"]')!,
    new File([JSON.stringify(backup)], "settings.json", { type: "application/json" }),
  );
  await expect
    .element(page.getByRole("dialog", { name: "Import settings into Server?" }))
    .toBeVisible();
  await screen.rerender(
    view(
      environments.map((entry) =>
        entry.label === "Server" ? { ...entry, connection: { phase: "disconnected" } } : entry,
      ) as Scope["connectedEnvironments"],
    ),
  );
  await expect
    .element(screen.getByRole("button", { name: "Environment scope: Laptop" }))
    .toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Laptop", exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Export" })).toBeVisible();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await screen.rerender(
    view(
      environments.map((entry) =>
        entry.label === "Server" ? { ...entry, serverConfig: null } : entry,
      ),
    ),
  );
  await expect
    .element(screen.getByRole("button", { name: "Environment scope: Laptop" }))
    .toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Laptop", exact: true })).toBeVisible();
  await screen.rerender(view(environments));
  await expect
    .element(screen.getByRole("button", { name: "Environment scope: Server" }))
    .toBeVisible();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await screen.rerender(view([]));
  await expect
    .element(screen.getByRole("button", { name: /^Environment scope:/ }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Export" })).not.toBeInTheDocument();
  await expect
    .element(screen.getByText("Choose one connected environment to import or export app settings."))
    .toBeVisible();
});

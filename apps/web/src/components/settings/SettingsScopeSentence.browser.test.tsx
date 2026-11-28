import { createContext, useContext, useState } from "react";
import { DEFAULT_CLIENT_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import type { EnvironmentPresentation } from "../../state/environments";
import type { ProjectTypeFilter } from "./settingsScopeAxis";
import type { SettingsScopeSearch } from "./settingsScope";

vi.mock(import("./SettingsScopeContext"), () => ({
  useSettingsScope: () => useContext(TestScopeContext)!,
  useOptionalSettingsScope: () => useContext(TestScopeContext),
  SettingsScopeProvider: (() => null) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: useContext(TestEnvironmentsContext) })) as never,
  usePrimaryEnvironmentId: () => EnvironmentId.make("gmac"),
}));

import { SettingsScopeSentence } from "./SettingsScopeSentence";

const TestScopeContext = createContext<ReturnType<
  typeof import("./SettingsScopeContext").useSettingsScope
> | null>(null);
const TestEnvironmentsContext = createContext<readonly EnvironmentPresentation[]>([]);

function ScopeHarness({
  pathname,
  environments = [],
  initialSearch = {},
  singleEnvironment = false,
}: {
  pathname?: string;
  environments?: readonly EnvironmentPresentation[];
  initialSearch?: SettingsScopeSearch;
  singleEnvironment?: boolean;
}) {
  const [search, selectScope] = useState<SettingsScopeSearch>(initialSearch);
  const [projectTypeFilter, setProjectTypeFilter] = useState<ProjectTypeFilter>("all");
  const value = {
    search,
    selectScope,
    projectTypeFilter,
    setProjectTypeFilter,
    singleEnvironment,
    groups: [],
    scope: search.machine
      ? { kind: "environment", environmentId: search.machine }
      : { kind: "all" },
  } as never;
  return (
    <TestEnvironmentsContext value={environments}>
      <TestScopeContext value={value}>
        <SettingsScopeSentence {...(pathname !== undefined ? { pathname } : {})} />
      </TestScopeContext>
    </TestEnvironmentsContext>
  );
}

const sampleEnvironments = [
  {
    environmentId: EnvironmentId.make("gmac"),
    label: "Gmac",
    displayUrl: null,
    entry: { enabled: true },
    connection: { phase: "connected" },
    serverConfig: {
      environment: {
        platform: { machine: "laptop" },
        capabilities: { peerLinks: true },
      },
    },
  },
] as unknown as EnvironmentPresentation[];

it("keeps the project scope label in sync with the type filter", async () => {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage: "en" });
  await using screen = await render(<ScopeHarness pathname="/settings/projects" />, {
    router: "/settings/projects",
  });

  for (const label of ["Groups", "Projects", "All"]) {
    await screen.getByRole("combobox", { name: /^Project scope:/ }).click();
    await screen.getByRole("button", { name: label, exact: true }).click();
    await screen.getByRole("option", { name: label, exact: true }).click();
    await expect
      .element(screen.getByRole("combobox", { name: `Project scope: ${label}`, exact: true }))
      .toBeVisible();
  }
});

it("shows environment and project controls on scoped pages, environment-only on machine pages, and hides on pure device pages", async () => {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage: "en" });

  {
    await using screen = await render(
      <ScopeHarness
        pathname="/settings/providers"
        environments={sampleEnvironments}
        initialSearch={{ machine: "gmac" }}
      />,
      { router: "/settings/providers" },
    );
    await expect
      .element(screen.getByRole("button", { name: "Environment scope: Gmac" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("combobox", { name: "Project scope: All" }))
      .toBeVisible();
  }

  for (const path of [
    "/settings/chat",
    "/settings/general",
    "/settings/connections",
    "/settings/access",
    "/settings/skills",
  ]) {
    await using screen = await render(
      <ScopeHarness
        pathname={path}
        environments={sampleEnvironments}
        initialSearch={{ machine: "gmac" }}
      />,
      { router: path },
    );
    await expect
      .element(screen.getByRole("button", { name: "Environment scope: Gmac" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("combobox", { name: /^Project scope:/ }))
      .not.toBeInTheDocument();
  }

  for (const path of [
    "/settings/appearance",
    "/settings/diffs",
    "/settings/about",
    "/settings/open-source-licenses",
  ]) {
    await using screen = await render(
      <ScopeHarness
        pathname={path}
        environments={sampleEnvironments}
        initialSearch={{ machine: "gmac" }}
      />,
      { router: path },
    );
    await expect
      .element(screen.getByRole("button", { name: /^Environment scope:/ }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("combobox", { name: /^Project scope:/ }))
      .not.toBeInTheDocument();
  }
});

import { createContext, useContext, useState } from "react";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import type { ProjectTypeFilter } from "./settingsScopeAxis";
import type { SettingsScopeSearch } from "./settingsScope";

vi.mock(import("./SettingsScopeContext"), () => ({
  useSettingsScope: () => useContext(TestScopeContext)!,
  useOptionalSettingsScope: () => useContext(TestScopeContext),
  SettingsScopeProvider: (() => null) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [] })) as never,
}));

import { SettingsScopeSentence } from "./SettingsScopeSentence";

const TestScopeContext = createContext<ReturnType<
  typeof import("./SettingsScopeContext").useSettingsScope
> | null>(null);

function ScopeHarness() {
  const [search, selectScope] = useState<SettingsScopeSearch>({});
  const [projectTypeFilter, setProjectTypeFilter] = useState<ProjectTypeFilter>("all");
  const value = {
    search,
    selectScope,
    projectTypeFilter,
    setProjectTypeFilter,
    groups: [],
    scope: { kind: "all" },
  } as never;
  return (
    <TestScopeContext value={value}>
      <SettingsScopeSentence />
    </TestScopeContext>
  );
}

it("keeps the project scope label in sync with the type filter", async () => {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, uiLanguage: "en" });
  await using screen = await render(<ScopeHarness />, { router: "/settings/projects" });

  for (const label of ["Groups", "Projects", "All"]) {
    await screen.getByRole("combobox", { name: /^Project scope:/ }).click();
    await screen.getByRole("button", { name: label, exact: true }).click();
    await screen.getByRole("option", { name: label, exact: true }).click();
    await expect
      .element(screen.getByRole("combobox", { name: `Project scope: ${label}`, exact: true }))
      .toBeVisible();
  }
});

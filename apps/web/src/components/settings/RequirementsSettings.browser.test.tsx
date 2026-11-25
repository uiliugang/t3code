import "~/index.css";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { RequirementsSettings } from "./RequirementsSettings";

const mocks = vi.hoisted(() => ({ update: vi.fn() }));
const environmentId = EnvironmentId.make("legacy");
const projectId = ProjectId.make("project");
const github = { provider: "github", host: "github.com", scope: "team/old" } as const;
const mep = { provider: "meituan", host: "mep.sankuai.com", scope: "42" } as const;
const saved = [github, mep];
const settings = { issueProjectSources: { [projectId]: saved } };
const environment = {
  environmentId,
  connection: { phase: "connected" },
  serverConfig: { environment: { capabilities: {} }, settings },
};

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "environment" },
    search: {},
    environments: [environment],
    connectedEnvironments: [environment],
  })) as never,
}));
vi.mock(import("./IssueTrackerSettings"), async (original) => ({
  ...(await original()),
  IssueTrackerSettings: () => null,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((_id: unknown, select: (value: typeof settings) => unknown) =>
    select(settings)) as never,
}));
vi.mock(import("../../hooks/useUiTranslation"), async () => {
  const { translateUi } = await import("@t3tools/shared/uiLocale");
  return { useUiTranslation: () => translateUi.bind(null, "en") };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [{ environmentId, id: projectId, title: "Example" }]) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({ data: sources, isPending: false })) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      updateSettings: { permissionAtom: () => Atom.make(true) } as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => mocks.update) as never,
}));
vi.mock(import("../../state/sourceControl"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    sourceControlEnvironment: {
      ...actual.sourceControlEnvironment,
      issueSources: (() => Atom.make(AsyncResult.success(sources))) as never,
    },
  };
});

const sources = [{ projectId, provider: "github", sources: [github] }];

it("preserves MEP when bulk saving or restoring GitHub on a legacy server", async () => {
  mocks.update.mockReset().mockResolvedValue({ _tag: "Success" });
  await using screen = await render(<RequirementsSettings />);
  await userEvent.click(screen.getByRole("checkbox", { name: "Select Example" }));
  await userEvent.click(screen.getByRole("button", { name: /^GitHub override/ }));
  await userEvent.fill(screen.getByRole("textbox", { name: "GitHub repository" }), "team/new");
  await userEvent.click(screen.getByRole("button", { name: "Save GitHub override" }));
  await expect.element(screen.getByText("Completed: 1 succeeded, 0 failed.")).toBeVisible();
  expect(mocks.update).toHaveBeenNthCalledWith(1, {
    environmentId,
    input: {
      expectedIssueProjectSources: { [projectId]: saved },
      patch: { issueProjectSources: { [projectId]: [mep, { ...github, scope: "team/new" }] } },
    },
  });
  await userEvent.click(screen.getByRole("button", { name: /^Restore GitHub automatic/ }));
  await expect.poll(() => mocks.update.mock.calls.length).toBe(2);
  expect(mocks.update).toHaveBeenNthCalledWith(2, {
    environmentId,
    input: {
      expectedIssueProjectSources: { [projectId]: saved },
      patch: { issueProjectSources: { [projectId]: [mep] } },
    },
  });
});

import "~/index.css";
import { EnvironmentId, ProjectId, type IssueSource } from "@t3tools/contracts";
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
const saved: IssueSource[] = [github, mep];
const settings = { issueProjectSources: { [projectId]: saved } };
const environment = {
  environmentId,
  connection: { phase: "connected" },
  serverConfig: {
    environment: {
      capabilities: {} as { issueProjectSourcesCas?: boolean; githubIssueSourcePorts?: boolean },
    },
    settings,
  },
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

it("does not bulk edit an older server that cannot compare saved sources", async () => {
  mocks.update.mockReset();
  environment.serverConfig.environment.capabilities = {};
  await using screen = await render(<RequirementsSettings />);
  await userEvent.click(screen.getByRole("checkbox", { name: "Select Example" }));
  await expect.element(screen.getByRole("button", { name: /^GitHub override/ })).toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: /^Restore GitHub automatic/ }))
    .toBeDisabled();
  expect(mocks.update).not.toHaveBeenCalled();
});

it("preserves MEP when bulk saving or restoring GitHub with compare-and-set support", async () => {
  mocks.update.mockReset().mockResolvedValue({ _tag: "Success" });
  environment.serverConfig.environment.capabilities = {
    issueProjectSourcesCas: true,
    githubIssueSourcePorts: true,
  };
  await using screen = await render(<RequirementsSettings />);
  await userEvent.click(screen.getByRole("checkbox", { name: "Select Example" }));
  await userEvent.click(screen.getByRole("button", { name: /^GitHub override/ }));
  await userEvent.fill(screen.getByRole("textbox", { name: "GitHub repository" }), "team/new");
  await userEvent.fill(
    screen.getByRole("textbox", { name: "GitHub host" }),
    "forge.example.test:8443",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save GitHub override" }));
  await expect.element(screen.getByText("Completed: 1 succeeded, 0 failed.")).toBeVisible();
  expect(mocks.update).toHaveBeenNthCalledWith(1, {
    environmentId,
    input: {
      expectedIssueProjectSources: { [projectId]: saved },
      patch: {
        issueProjectSources: {
          [projectId]: [
            mep,
            { provider: "github", host: "forge.example.test:8443", scope: "team/new" },
          ],
        },
      },
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

it("does not overwrite sources that changed while the bulk editor was open", async () => {
  mocks.update.mockReset().mockResolvedValue({ _tag: "Success" });
  environment.serverConfig.environment.capabilities = { issueProjectSourcesCas: true };
  await using screen = await render(<RequirementsSettings />);
  await userEvent.click(screen.getByRole("checkbox", { name: "Select Example" }));
  await userEvent.click(screen.getByRole("button", { name: /^GitHub override/ }));
  await userEvent.fill(screen.getByRole("textbox", { name: "GitHub repository" }), "team/new");
  environment.serverConfig.settings = {
    issueProjectSources: { [projectId]: [{ ...github, scope: "team/concurrent" }, mep] },
  };
  try {
    await screen.rerender(<RequirementsSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Save GitHub override" }));
    await expect
      .element(screen.getByText("Project sources have changed. Reopen the editor and try again."))
      .toBeVisible();
    expect(mocks.update).not.toHaveBeenCalled();
  } finally {
    environment.serverConfig.settings = settings;
  }
});

it("requires port support for a non-default port but normalizes the default port for older servers", async () => {
  mocks.update.mockReset().mockResolvedValue({ _tag: "Success" });
  environment.serverConfig.environment.capabilities = { issueProjectSourcesCas: true };
  await using screen = await render(<RequirementsSettings />);
  await userEvent.click(screen.getByRole("checkbox", { name: "Select Example" }));
  await userEvent.click(screen.getByRole("button", { name: /^GitHub override/ }));
  await userEvent.fill(screen.getByRole("textbox", { name: "GitHub repository" }), "team/new");
  const host = screen.getByRole("textbox", { name: "GitHub host" });
  const save = screen.getByRole("button", { name: "Save GitHub override" });
  await userEvent.fill(host, "forge.example.test:8443");
  await expect.element(save).toBeDisabled();
  expect(mocks.update).not.toHaveBeenCalled();
  await userEvent.fill(host, "GitHub.com:443");
  await userEvent.click(save);
  expect(mocks.update).toHaveBeenCalledWith({
    environmentId,
    input: {
      expectedIssueProjectSources: { [projectId]: saved },
      patch: { issueProjectSources: { [projectId]: [mep, { ...github, scope: "team/new" }] } },
    },
  });
});

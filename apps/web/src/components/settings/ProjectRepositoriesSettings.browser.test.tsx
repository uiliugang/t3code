import { RegistryContext } from "@effect/atom-react";
import type { UpdateProjectInput } from "@t3tools/client-runtime/state/projects";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  EnvironmentId,
  ProjectId,
  type AuthEnvironmentScope,
  type ServerConfig,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import type { Project } from "../../types";

const state = vi.hoisted(() => ({
  scopes: null as Atom.Writable<ReadonlySet<AuthEnvironmentScope>> | null,
  config: null as Atom.Writable<ServerConfig | null> | null,
  update:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: UpdateProjectInput;
      }) => Promise<AsyncResult.Success<void>>
    >(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: () => state.config!,
    } as unknown as typeof actual.serverEnvironment,
  };
});

vi.mock(import("../../state/session"), async (original) => {
  const actual = await original();
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    ...actual,
    useEnvironmentScope: ((_environmentId: EnvironmentId, scope: AuthEnvironmentScope) =>
      useAtomValue(state.scopes!).has(scope)) as typeof actual.useEnvironmentScope,
  };
});

vi.mock(import("../../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: (() => state.update) as never,
}));

vi.mock(import("../../hooks/useUiTranslation"), () => ({
  useUiTranslation: () => (message: string) => message,
}));

vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: vi.fn() } };
});

import { ProjectRepositoriesSettings } from "./ProjectRepositoriesSettings";

const environmentId = EnvironmentId.make("env-local");
const legacySetupScript = {
  id: "setup",
  name: "Setup",
  command: "echo legacy-setup",
  icon: "configure" as const,
  runOnWorktreeCreate: true,
};

const legacyProject = {
  id: ProjectId.make("project-1"),
  environmentId,
  title: "Repo",
  workspaceRoot: "/work/repo",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  scripts: [legacySetupScript],
  pinned: false,
  archived: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  isScratch: false,
} as unknown as Project;

it("preserves a legacy setupScript across initial permission hydration and disables editing without settings:write", async () => {
  const initialScopes: ReadonlySet<AuthEnvironmentScope> = new Set();
  state.scopes = Atom.make(initialScopes);
  state.config = Atom.make<ServerConfig | null>({
    environment: { capabilities: { multiRepositoryWorkspaces: true } },
  } as unknown as ServerConfig);
  state.update.mockResolvedValue(AsyncResult.success(undefined));

  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <ProjectRepositoriesSettings project={legacyProject} />
    </RegistryContext.Provider>,
  );
  const commandInput = screen.getByRole("textbox", { name: "Worktree setup command" });
  const saveButton = screen.getByRole("button", { name: "Save repositories" });

  await expect.element(commandInput).toHaveValue("echo legacy-setup");
  await expect.element(commandInput).toBeDisabled();
  await expect.element(saveButton).toBeDisabled();

  // Operate-only permission keeps the legacy setupScript visible and prevents saving without settings:write.
  await act(async () => {
    appAtomRegistry.set(state.scopes!, new Set([AuthOrchestrationOperateScope]));
  });
  await expect.element(commandInput).toHaveValue("echo legacy-setup");
  await expect.element(commandInput).toBeDisabled();
  await expect.element(saveButton).toBeDisabled();

  // Once settings:write finishes loading, the original legacy setupScript is still intact and saved.
  await act(async () => {
    appAtomRegistry.set(
      state.scopes!,
      new Set([AuthOrchestrationOperateScope, AuthSettingsWriteScope]),
    );
  });
  await expect.element(commandInput).toBeEnabled();
  await expect.element(saveButton).toBeEnabled();

  const aliasInput = screen.getByRole("textbox", { name: "Repository name" });
  await userEvent.clear(aliasInput);
  await userEvent.type(aliasInput, "MainRepo");
  await userEvent.click(saveButton);

  expect(state.update).toHaveBeenCalledOnce();
  expect(state.update.mock.calls[0]?.[0]?.input.workspaceConfig?.roots).toMatchObject([
    {
      alias: "MainRepo",
      sourcePath: "/work/repo",
      setupScript: legacySetupScript,
    },
  ]);
});

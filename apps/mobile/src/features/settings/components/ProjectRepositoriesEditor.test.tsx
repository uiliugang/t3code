import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  EnvironmentId,
  ProjectId,
  type ServerConfig,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type InputProps = {
  accessibilityLabel: string;
  editable?: boolean;
  value?: string;
  onChangeText?: (text: string) => void;
};

type ButtonProps = {
  label: string;
  disabled?: boolean;
  onPress?: () => void;
};

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  inputs: new Map<string, InputProps>(),
  buttons: new Map<string, ButtonProps>(),
  update: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    ({
      environment: { capabilities: { multiRepositoryWorkspaces: true } },
    }) as unknown as ServerConfig,
}));
vi.mock("../../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => "config" },
}));
vi.mock("../../../state/projects", () => ({
  projectEnvironment: { update: "update" },
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: () => state.update,
}));
vi.mock("../../../state/session", () => ({
  useEnvironmentScope: (_environmentId: EnvironmentId, scope: string) => state.scopes.has(scope),
}));
vi.mock("../settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedProjectKey: "key",
    getSelectedProjectKey: () => "key",
    selectProject: vi.fn(),
  }),
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: (props: InputProps) => {
    state.inputs.set(props.accessibilityLabel, props);
    return null;
  },
}));
vi.mock("../../../components/ui/Button", () => ({
  Button: (props: ButtonProps) => {
    state.buttons.set(props.label, props);
    return null;
  },
}));
vi.mock("../../../components/ui/Dialog", () => ({
  alert: vi.fn(),
}));
vi.mock("./SettingsSection", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../../lib/useUiTranslation", () => ({
  useUiTranslation: () => (message: string) => message,
}));
vi.mock("../../../lib/uuid", () => ({
  uuidv4: () => "00000000-0000-4000-8000-000000000001",
}));

import { ProjectRepositoriesEditor } from "./ProjectRepositoriesEditor";

const legacySetupScript = {
  id: "setup",
  name: "Setup",
  command: "echo mobile-legacy-setup",
  icon: "configure" as const,
  runOnWorktreeCreate: true,
};

const legacyProject = {
  id: ProjectId.make("project-mobile-1"),
  environmentId: EnvironmentId.make("env-mobile"),
  title: "MobileRepo",
  workspaceRoot: "/work/mobile",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  projectIcon: null,
  scripts: [legacySetupScript],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  isScratch: false,
} as unknown as EnvironmentProject;

let root: Root;

function renderEditor() {
  act(() => {
    root.render(<ProjectRepositoriesEditor project={legacyProject} />);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  state.scopes = new Set();
  state.inputs.clear();
  state.buttons.clear();
  state.update.mockReset();
  state.update.mockResolvedValue(
    AsyncResult.success({ ...legacyProject, workspaceConfig: { version: 1 } }),
  );
});

afterEach(() => {
  act(() => root.unmount());
});

describe("ProjectRepositoriesEditor", () => {
  it("preserves a legacy setupScript across false -> true permission updates and gates editing on settings:write", async () => {
    // 1. Session permissions still loading (both false).
    renderEditor();
    expect(state.inputs.get("Worktree setup command")?.value).toBe("echo mobile-legacy-setup");
    expect(state.inputs.get("Worktree setup command")?.editable).toBe(false);
    expect(state.buttons.get("Save repositories")?.disabled).toBe(true);

    // 2. Operate-only loaded: setupScript stays intact, input & save stay disabled.
    state.scopes = new Set([AuthOrchestrationOperateScope]);
    renderEditor();
    expect(state.inputs.get("Worktree setup command")?.value).toBe("echo mobile-legacy-setup");
    expect(state.inputs.get("Worktree setup command")?.editable).toBe(false);
    expect(state.buttons.get("Save repositories")?.disabled).toBe(true);

    // 3. settings:write arrives: legacy setupScript is still preserved and saved on submit.
    state.scopes = new Set([AuthOrchestrationOperateScope, AuthSettingsWriteScope]);
    renderEditor();
    expect(state.inputs.get("Worktree setup command")?.editable).toBe(true);
    expect(state.buttons.get("Save repositories")?.disabled).toBe(false);

    act(() => {
      state.inputs.get("Repository name")?.onChangeText?.("MobileUpdated");
    });
    await act(async () => {
      state.buttons.get("Save repositories")?.onPress?.();
    });

    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]?.[0]?.input.workspaceConfig?.roots).toMatchObject([
      {
        alias: "MobileUpdated",
        sourcePath: "/work/mobile",
        setupScript: legacySetupScript,
      },
    ]);
  });
});

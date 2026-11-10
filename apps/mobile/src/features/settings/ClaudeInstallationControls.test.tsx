import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { CLAUDE_DRIVER, DEFAULT_CLAUDE_INSTANCE_ID } from "./claude-accounts";
import type { SettingsTarget } from "./settings-environment-filter";

const { mutate, Children } = vi.hoisted(() => ({
  mutate: vi.fn(),
  Children: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("react-native", () => ({ View: Children }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/ControlPill", () => ({
  ControlPill: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({
    children,
    actions,
    onPressAction,
  }: {
    children: ReactNode;
    actions: { id: string; title: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) => (
    <>
      {children}
      {actions.map((action) => (
        <button
          key={action.id}
          onClick={() => onPressAction({ nativeEvent: { event: action.id } })}
        >
          {action.title}
        </button>
      ))}
    </>
  ),
}));
vi.mock("../../lib/useUiTranslation", () => ({ useUiTranslation: () => (text: string) => text }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    mutateProviderInstance: { permissionAtom: () => null },
    startProviderInstall: { permissionAtom: () => null },
    cancelProviderInstall: { permissionAtom: () => null },
    removeProviderInstallation: { permissionAtom: () => null },
    providerInstallState: () => null,
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mutate }));

import { ClaudeInstallationControls } from "./ClaudeInstallationControls";

it.each([
  { name: "implicit default", instance: undefined },
  {
    name: "configured instance",
    instance: {
      driver: CLAUDE_DRIVER,
      enabled: false,
      config: { binaryPath: "/opt/local/claude", homePath: "~/.claude-work" },
    },
  },
] satisfies { name: string; instance: ProviderInstanceConfig | undefined }[])(
  "switches $name to managed installation",
  ({ instance }) => {
    mutate.mockReset();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const environmentId = EnvironmentId.make("local");
    const instanceId = DEFAULT_CLAUDE_INSTANCE_ID;
    const environment = {
      environmentId,
      serverConfig: {
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: instance ? { [instanceId]: instance } : {},
        },
      },
    } as SettingsTarget;
    const provider: ServerProvider = {
      instanceId,
      driver: CLAUDE_DRIVER,
      enabled: true,
      installed: false,
      version: null,
      checkedAt: "2026-11-10T00:00:00.000Z",
      status: "error",
      auth: { status: "unknown" },
      models: [],
      slashCommands: [],
      skills: [],
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() =>
        root.render(<ClaudeInstallationControls environment={environment} provider={provider} />),
      );
      act(() =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Managed by T3")!
          .click(),
      );
      expect(mutate).toHaveBeenCalledWith({
        environmentId,
        input: {
          patch: {},
          providerInstanceMutation: {
            operation: "upsert",
            instanceId,
            instance: {
              ...(instance ?? { driver: CLAUDE_DRIVER }),
              config: { ...instance?.config, setupMode: "managed" },
            },
          },
        },
      });
    } finally {
      act(() => root.unmount());
    }
  },
);

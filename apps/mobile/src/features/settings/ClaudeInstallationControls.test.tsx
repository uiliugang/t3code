import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ProviderInstanceConfig,
  ProviderDriverKind,
  ProviderInstanceId,
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
vi.mock("react-native", () => ({
  View: Children,
  Pressable: ({
    children,
    accessibilityLabel,
    disabled,
    onPress,
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    accessibilityLabel: string;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onInput={(event) => onChangeText(event.currentTarget.value)}
      readOnly
    />
  ),
  Switch: () => null,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/KeyboardSheetBody", () => ({ KeyboardSheetBody: Children }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/Sheet", () => ({
  Sheet: ({
    children,
    onClose,
    dismissDisabled,
  }: {
    children: ReactNode;
    onClose: () => void;
    dismissDisabled?: boolean;
  }) => (
    <section role="dialog">
      <button aria-label="Close" disabled={dismissDisabled} onClick={onClose} />
      {children}
    </section>
  ),
}));
vi.mock("../../components/ui/ControlPill", () => ({
  ControlPill: ({
    label,
    accessibilityLabel,
    disabled,
    onPress,
  }: {
    label?: string;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button aria-label={accessibilityLabel ?? label} disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/ListRow", () => ({
  ListRow: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/ListToggleRow", () => ({
  ListToggleRow: ({
    label,
    value,
    disabled,
    onValueChange,
  }: {
    label: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <button
      role="switch"
      aria-label={label}
      aria-checked={value}
      disabled={disabled}
      onClick={() => onValueChange(!value)}
    />
  ),
}));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
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
    validateProviderEndpoint: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mutate }));

import { ClaudeInstallationControls } from "./ClaudeInstallationControls";
import { AddProviderConnection } from "./AddProviderConnection";
import { ClaudeByokProviderSettings } from "./ClaudeByokProviderSettings";

it("keeps API edits until they are reverted before switching the Claude connection", () => {
  mutate.mockReset().mockResolvedValue({ _tag: "Success" });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const instanceId = ProviderInstanceId.make("claude_test");
  const instance: ProviderInstanceConfig = {
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Test connection",
    config: { customModelsOnly: true, customModels: ["model"] },
    environment: [
      { name: "ANTHROPIC_BASE_URL", value: "https://saved.test", sensitive: false },
      { name: "ANTHROPIC_API_KEY", value: "", sensitive: true, valueRedacted: true },
    ],
  };
  const provider = { instanceId, driver: instance.driver } as ServerProvider;
  const environment = {
    environmentId: EnvironmentId.make("local"),
    serverConfig: {
      environment: { capabilities: { providerConnectionProfiles: true } },
      settings: { ...DEFAULT_SERVER_SETTINGS, providerInstances: { [instanceId]: instance } },
    },
  } as SettingsTarget;
  const container = document.createElement("div");
  const root = createRoot(container);
  const click = (name: string) =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === name)!
      .click();
  try {
    act(() =>
      root.render(
        <ClaudeByokProviderSettings
          environment={environment}
          providers={[provider]}
          allowCreate={false}
        />,
      ),
    );
    act(() => click("Test connection"));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="API base URL"]')!;
    act(() => {
      input.value = "https://draft.test";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => click("Claude account / existing CLI"));
    expect(mutate).not.toHaveBeenCalled();
    expect(input.value).toBe("https://draft.test");
    act(() => click("Revert"));
    expect(input.value).toBe("https://saved.test");
    act(() => click("Claude account / existing CLI"));
    expect(mutate.mock.calls[0]?.[0].input.providerInstanceMutation).toEqual({
      operation: "switch-connection",
      instanceId,
      connectionMode: "existing",
      expectedConnectionMode: "byok",
    });
  } finally {
    act(() => root.unmount());
  }
});

it.each(["codex", "claudeAgent"])(
  "adds %s without replacing its implicit default",
  async (driver) => {
    mutate.mockReset().mockResolvedValue({ _tag: "Success" });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      const environment = {
        environmentId: EnvironmentId.make("local"),
        serverConfig: {
          environment: { capabilities: { providerConnectionProfiles: true } },
          settings: DEFAULT_SERVER_SETTINGS,
        },
      } as SettingsTarget;
      act(() => root.render(<AddProviderConnection environment={environment} providers={[]} />));
      act(() => container.querySelector("button")!.click());
      const selectDriver = () =>
        [...container.querySelectorAll("button")]
          .find(
            (button) =>
              button.textContent === (driver === "codex" ? "Add Codex" : "Add Claude Code"),
          )!
          .click();
      act(selectDriver);
      act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
      expect(mutate).not.toHaveBeenCalled();
      act(() => container.querySelector("button")!.click());
      expect(container.querySelector("input")).toBeNull();
      act(selectDriver);
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Add")!
          .click(),
      );
      expect(mutate.mock.calls[0]?.[0].input.providerInstanceMutation.instanceId).toBe(
        `${driver}_2`,
      );
    } finally {
      act(() => root.unmount());
    }
  },
);

it("reenables a saved provider from Add, preserving settings and allowing retry after failure", async () => {
  mutate.mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const instanceId = ProviderInstanceId.make("codex_work");
  const instance: ProviderInstanceConfig = {
    driver: ProviderDriverKind.make("codex"),
    enabled: false,
    config: { connectionMode: "byok", homePath: "/work/codex" },
    environment: [{ name: "API_KEY", value: "", sensitive: true, valueRedacted: true }],
  };
  const environment = {
    environmentId: EnvironmentId.make("local"),
    serverConfig: {
      environment: { capabilities: { providerConnectionProfiles: true } },
      settings: { ...DEFAULT_SERVER_SETTINGS, providerInstances: { [instanceId]: instance } },
    },
  } as SettingsTarget;
  const provider = {
    instanceId,
    driver: instance.driver,
    displayName: "Work Codex",
    enabled: false,
  } as ServerProvider;
  let finish!: (result: { _tag: "Success" | "Failure" }) => void;
  mutate.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(<AddProviderConnection environment={environment} providers={[provider]} />),
    );
    expect(container.querySelector('[role="switch"]')).toBeNull();
    act(() => container.querySelector("button")!.click());
    const enable = container.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="Work Codex"]',
    )!;
    expect(enable.getAttribute("aria-checked")).toBe("false");
    act(() => {
      enable.click();
      enable.click();
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0].input.providerInstanceMutation).toEqual({
      operation: "upsert",
      instanceId,
      instance: { ...instance, enabled: true },
    });
    expect(enable.disabled).toBe(true);
    expect(enable.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.disabled).toBe(true);
    await act(async () => finish({ _tag: "Failure" }));
    expect(enable.getAttribute("aria-checked")).toBe("false");
    expect(enable.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.disabled).toBe(
      false,
    );
    act(() => enable.click());
    expect(mutate).toHaveBeenCalledTimes(2);
    await act(async () => finish({ _tag: "Success" }));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[aria-label="Add provider"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

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
        environment: { capabilities: {} },
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

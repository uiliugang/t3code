import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { SettingsTarget } from "./settings-environment-filter";

const { Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("react-native", () => ({
  View: Children,
  Switch: () => null,
  TextInput: ({ accessibilityLabel, value }: { accessibilityLabel: string; value: string }) => (
    <input aria-label={accessibilityLabel} value={value} readOnly />
  ),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({
    children,
    accessibilityRole,
  }: {
    children?: ReactNode;
    accessibilityRole?: "alert";
  }) => <span role={accessibilityRole}>{children}</span>,
}));
vi.mock("../../components/ui/ControlPill", () => ({
  ControlPill: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/ListRow", () => ({
  ListRow: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("../../components/ui/ListToggleRow", () => ({ ListToggleRow: () => null }));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/Menu", () => ({ Menu: Children }));
vi.mock("../../lib/useUiTranslation", () => ({
  useUiTranslation: () => (message: string, values?: Record<string, string>) =>
    message.replace(/\{(\w+)\}/gu, (match, key: string) => values?.[key] ?? match),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    mutateProviderInstance: { permissionAtom: () => null },
    validateProviderEndpoint: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { ClaudeByokProviderSettings } from "./ClaudeByokProviderSettings";

it("opens and closes a new BYOK provider before any validation feedback exists", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const environment = {
    environmentId: EnvironmentId.make("local"),
    serverConfig: { settings: DEFAULT_SERVER_SETTINGS },
  } as SettingsTarget;
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    act(() => root.render(<ClaudeByokProviderSettings environment={environment} />));
    act(() => container.querySelector("button")!.click());

    expect(container.querySelector('input[aria-label="Model IDs"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();

    const revert = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Revert",
    );
    act(() => revert!.click());

    expect(container.querySelector('input[aria-label="Model IDs"]')).toBeNull();
    expect(container.querySelector("button")?.textContent).toMatch(/^Add /u);
  } finally {
    act(() => root.unmount());
  }
});

it.each(["claudeAgent", "codex"] as const)(
  "hides disabled %s connections until requested without hiding new connections",
  (driver) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const environment = {
      environmentId: EnvironmentId.make("local"),
      serverConfig: {
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("enabled_api")]: {
              driver: ProviderDriverKind.make(driver),
              displayName: "Enabled API",
              config: { connectionMode: "byok", customModelsOnly: true },
            },
            [ProviderInstanceId.make("disabled_api")]: {
              driver: ProviderDriverKind.make(driver),
              displayName: "Disabled API",
              enabled: false,
              config: { connectionMode: "byok", customModelsOnly: true },
            },
          },
        },
      },
    } as SettingsTarget;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() =>
        root.render(<ClaudeByokProviderSettings environment={environment} driver={driver} />),
      );
      expect(container.textContent).toContain("Enabled API");
      expect(container.textContent).not.toContain("Disabled API");
      expect(container.querySelector("button")?.textContent).toMatch(/^Add /u);

      act(() =>
        root.render(
          <ClaudeByokProviderSettings environment={environment} driver={driver} showDisabled />,
        ),
      );
      expect(container.textContent).toContain("Disabled API");
    } finally {
      act(() => root.unmount());
    }
  },
);

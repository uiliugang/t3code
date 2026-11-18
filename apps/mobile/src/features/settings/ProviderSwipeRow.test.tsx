import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { SettingsTarget } from "./settings-environment-filter";

const { mutate, alert, permission, Children } = vi.hoisted(() => ({
  mutate: vi.fn(),
  alert: vi.fn(),
  permission: { allowed: true },
  Children: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("react-native", () => ({ View: Children, useWindowDimensions: () => ({ width: 390 }) }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => permission.allowed }));
vi.mock("../home/thread-swipe-actions", () => ({
  ThreadSwipeable: ({
    primaryAction,
    secondaryAction,
    middleAction,
    enabled,
    children,
  }: {
    primaryAction: { accessibilityLabel: string; disabled?: boolean; onPress: () => void };
    secondaryAction: { accessibilityLabel: string; disabled?: boolean; onPress: () => void } | null;
    middleAction?: { accessibilityLabel: string; disabled?: boolean; onPress: () => void };
    enabled: boolean;
    children: () => ReactNode;
  }) => (
    <>
      {children()}
      {[primaryAction, middleAction, secondaryAction]
        .filter((action) => action != null)
        .map((action) => (
          <button
            key={action.accessibilityLabel}
            aria-label={action.accessibilityLabel}
            disabled={!enabled || action.disabled}
            onClick={action.onPress}
          />
        ))}
    </>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert }));
vi.mock("../../lib/useUiTranslation", () => ({ useUiTranslation: () => (text: string) => text }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { mutateProviderInstance: { permissionAtom: () => null } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mutate }));

import { ProviderSwipeRow } from "./ProviderSwipeRow";

it("reports cleanup errors after the last provider disappears", async () => {
  mutate.mockReset();
  alert.mockReset();
  permission.allowed = true;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const environmentId = EnvironmentId.make("remote");
  const instanceId = ProviderInstanceId.make("codex");
  const environment = {
    environmentId,
    serverConfig: {
      environment: { capabilities: { providerInstanceDeletion: true } },
      settings: DEFAULT_SERVER_SETTINGS,
    },
  } as SettingsTarget;
  const provider = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
  } as ServerProvider;
  const container = document.createElement("div");
  const root = createRoot(container);
  const onError = vi.fn();
  const onEdit = vi.fn();
  let finish!: (result: AsyncResult.Failure<never, Error>) => void;
  mutate.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    act(() =>
      root.render(
        <ProviderSwipeRow
          environment={environment}
          provider={provider}
          onError={onError}
          onEdit={onEdit}
          onSwipeableWillOpen={() => {}}
        >
          Codex
        </ProviderSwipeRow>,
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Edit: Codex"]')!.click());
    expect(onEdit).toHaveBeenCalledOnce();
    expect(alert).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Remove provider: Codex"]')!.click(),
    );
    expect(mutate).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0]![2] as { style?: string; onPress?: () => void }[];
    act(() => buttons.find((button) => button.style === "cancel")?.onPress?.());
    expect(mutate).not.toHaveBeenCalled();
    const confirm = buttons.find((button) => button.style === "destructive")!.onPress!;
    act(() => {
      confirm();
      confirm();
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({
      environmentId,
      input: { patch: {}, providerInstanceMutation: { operation: "delete", instanceId } },
    });
    expect(container.querySelector("button")!.disabled).toBe(true);
    act(() => root.render(null));
    await act(async () =>
      finish(AsyncResult.failure(Cause.fail(new Error("Managed files remain")))),
    );
    expect(onError).toHaveBeenLastCalledWith("Managed files remain");
    expect(container.querySelector("button")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it.each([
  { allowed: false, supported: true },
  { allowed: true, supported: false },
])(
  "does not remove a provider when allowed=$allowed and supported=$supported",
  ({ allowed, supported }) => {
    mutate.mockReset();
    alert.mockReset();
    permission.allowed = allowed;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const environment = {
      environmentId: EnvironmentId.make("remote"),
      serverConfig: {
        environment: { capabilities: { providerInstanceDeletion: supported } },
        settings: DEFAULT_SERVER_SETTINGS,
      },
    } as SettingsTarget;
    const container = document.createElement("div");
    const root = createRoot(container);
    const onError = vi.fn();
    try {
      act(() =>
        root.render(
          <ProviderSwipeRow
            environment={environment}
            provider={{
              instanceId: ProviderInstanceId.make("codex"),
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
            }}
            onError={onError}
            onSwipeableWillOpen={() => {}}
          >
            Codex
          </ProviderSwipeRow>,
        ),
      );
      act(() =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Remove provider: codex"]')!
          .click(),
      );
      expect(mutate).not.toHaveBeenCalled();
      expect(alert).not.toHaveBeenCalled();
      if (allowed)
        expect(onError).toHaveBeenCalledWith(
          "Update this environment's server to remove providers.",
        );
      else expect(onError).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  },
);

it.each([true, false])(
  "toggles enabled=%s without losing configuration and retries failures",
  async (enabled) => {
    mutate.mockReset();
    alert.mockReset();
    permission.allowed = true;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const instanceId = ProviderInstanceId.make("codex_work");
    const instance: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make("codex"),
      enabled,
      displayName: "Work",
      config: { connectionMode: "byok", homePath: "/work/codex" },
      connectionProfiles: { existing: { config: { homePath: "/personal/codex" } } },
      environment: [{ name: "API_KEY", value: "", sensitive: true, valueRedacted: true }],
    };
    const environment = {
      environmentId: EnvironmentId.make("remote"),
      serverConfig: {
        environment: { capabilities: { providerInstanceDeletion: true } },
        settings: { ...DEFAULT_SERVER_SETTINGS, providerInstances: { [instanceId]: instance } },
      },
    } as SettingsTarget;
    let finish!: (result: AsyncResult.AsyncResult<void, Error>) => void;
    mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const onError = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    const renderProvider = (current: boolean) =>
      root.render(
        <ProviderSwipeRow
          environment={environment}
          provider={{ instanceId, driver: instance.driver, displayName: "Work", enabled: current }}
          onError={onError}
          onEdit={() => {}}
          onSwipeableWillOpen={() => {}}
        >
          Work
        </ProviderSwipeRow>,
      );
    const button = () =>
      container.querySelector<HTMLButtonElement>(
        `[aria-label="${enabled ? "Disable" : "Enable"}: Work"]`,
      )!;
    const toggle = () => {
      button().click();
      if (enabled) {
        const buttons = alert.mock.lastCall![2] as { text: string; onPress?: () => void }[];
        buttons.find((entry) => entry.text === "Disable")!.onPress!();
      }
    };
    try {
      act(() => renderProvider(enabled));
      if (enabled) {
        act(() => button().click());
        expect(mutate).not.toHaveBeenCalled();
        const buttons = alert.mock.lastCall![2] as { style?: string; onPress?: () => void }[];
        act(() => buttons.find((entry) => entry.style === "cancel")?.onPress?.());
        expect(mutate).not.toHaveBeenCalled();
      }
      act(() => {
        toggle();
        toggle();
      });
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate).toHaveBeenCalledWith({
        environmentId: environment.environmentId,
        input: {
          patch: {},
          providerInstanceMutation: {
            operation: "upsert",
            instanceId,
            instance: { ...instance, enabled: !enabled },
          },
        },
      });
      expect(button().disabled).toBe(true);
      await act(async () => finish(AsyncResult.failure(Cause.fail(new Error("Save failed")))));
      expect(onError).toHaveBeenLastCalledWith("Save failed");
      expect(button().disabled).toBe(false);
      act(toggle);
      expect(mutate).toHaveBeenCalledTimes(2);
      await act(async () => {
        finish(AsyncResult.success(undefined));
        renderProvider(!enabled);
      });
      expect(
        container.querySelector(`[aria-label="${enabled ? "Enable" : "Disable"}: Work"]`),
      ).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  },
);

it.each([
  { allowed: false, locked: false },
  { allowed: true, locked: true },
])("does not toggle when allowed=$allowed and locked=$locked", ({ allowed, locked }) => {
  mutate.mockReset();
  alert.mockReset();
  permission.allowed = allowed;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const environment = {
    environmentId: EnvironmentId.make("remote"),
    serverConfig: {
      environment: { capabilities: { providerInstanceDeletion: true } },
      settings: DEFAULT_SERVER_SETTINGS,
    },
  } as SettingsTarget;
  const managedEnvironment: SettingsTarget = {
    ...environment,
    serverConfig: {
      ...environment.serverConfig,
      managedPolicy: {
        organization: "Test",
        lockedSettings: locked ? ["providerInstances.codex.enabled"] : [],
      },
    },
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <ProviderSwipeRow
          environment={managedEnvironment}
          provider={{
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
          }}
          onError={() => {}}
          onSwipeableWillOpen={() => {}}
        >
          Codex
        </ProviderSwipeRow>,
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Disable: codex"]')!.click());
    expect(mutate).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});

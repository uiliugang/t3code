import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
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
    enabled,
    children,
  }: {
    primaryAction: { onPress: () => void };
    secondaryAction: { onPress: () => void } | null;
    enabled: boolean;
    children: () => ReactNode;
  }) => (
    <>
      {children()}
      {secondaryAction ? (
        <button aria-label="Edit" disabled={!enabled} onClick={primaryAction.onPress} />
      ) : null}
      <button
        aria-label="Remove"
        disabled={!enabled}
        onClick={(secondaryAction ?? primaryAction).onPress}
      >
        Remove
      </button>
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
    serverConfig: { environment: { capabilities: { providerInstanceDeletion: true } } },
  } as SettingsTarget;
  const provider = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
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
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Edit"]')!.click());
    expect(onEdit).toHaveBeenCalledOnce();
    expect(alert).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove"]')!.click());
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
      serverConfig: { environment: { capabilities: { providerInstanceDeletion: supported } } },
    } as SettingsTarget;
    const container = document.createElement("div");
    const root = createRoot(container);
    const onError = vi.fn();
    try {
      act(() =>
        root.render(
          <ProviderSwipeRow
            environment={environment}
            provider={{ instanceId: ProviderInstanceId.make("codex") }}
            onError={onError}
            onSwipeableWillOpen={() => {}}
          >
            Codex
          </ProviderSwipeRow>,
        ),
      );
      act(() => container.querySelector("button")!.click());
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

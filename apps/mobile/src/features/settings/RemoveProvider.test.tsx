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
    onPressAction,
    actions,
  }: {
    actions: { id: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) => (
    <button onClick={() => onPressAction({ nativeEvent: { event: actions[0]!.id } })}>
      Remove
    </button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({
  alert: (_title: string, _message: string, buttons: { style?: string; onPress?: () => void }[]) =>
    buttons.find((button) => button.style === "destructive")?.onPress?.(),
}));
vi.mock("../../lib/useUiTranslation", () => ({ useUiTranslation: () => (text: string) => text }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { mutateProviderInstance: { permissionAtom: () => null } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mutate }));

import { RemoveProvider } from "./RemoveProvider";

it("keeps cleanup errors visible after the last provider disappears", async () => {
  mutate.mockReset();
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
  let finish!: (result: AsyncResult.Failure<never, Error>) => void;
  mutate.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    act(() => root.render(<RemoveProvider environment={environment} providers={[provider]} />));
    act(() => container.querySelector("button")!.click());
    expect(mutate).toHaveBeenCalledWith({
      environmentId,
      input: { patch: {}, providerInstanceMutation: { operation: "delete", instanceId } },
    });
    act(() => root.render(<RemoveProvider environment={environment} providers={[]} />));
    await act(async () =>
      finish(AsyncResult.failure(Cause.fail(new Error("Managed files remain")))),
    );
    expect(container.textContent).toContain("Managed files remain");
    expect(container.querySelector("button")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

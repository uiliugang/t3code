import { EnvironmentId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { SettingsTarget } from "../settings-environment-filter";

const mocks = vi.hoisted(() => ({ query: vi.fn(), command: vi.fn(), refresh: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("../../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../../lib/useUiTranslation", () => ({
  useUiTranslation: () => (message: string) => message,
}));
vi.mock("../../../state/query", () => ({ useEnvironmentQuery: mocks.query }));
vi.mock("../../../state/sourceControl", () => ({
  sourceControlEnvironment: {
    tools: () => "tools",
    discovery: () => "discovery",
    startTool: { permissionAtom: () => null },
    refreshTools: {},
  },
}));
vi.mock("../../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.command }));
vi.mock("./SettingsSection", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./SettingsRow", () => ({
  SettingsRow: ({
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

import { SourceControlToolsSection } from "./SourceControlToolsSection";

it("allows rescanning after the tool subscription emits without waiting for it to end", async () => {
  mocks.command.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.refresh.mockReset();
  const tools = { data: null as readonly [] | null, isPending: true, refresh: mocks.refresh };
  mocks.query
    .mockReset()
    .mockImplementation((atom) =>
      atom === "tools" ? tools : { data: null, isPending: false, refresh: mocks.refresh },
    );
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const environment = {
    environmentId: EnvironmentId.make("tools-test"),
    label: "Tools test",
    serverConfig: { environment: { capabilities: { sourceControlToolMaintenance: true } } },
  } as SettingsTarget;
  const container = document.createElement("div");
  const root = createRoot(container);
  using _mounted = { [Symbol.dispose]: () => act(() => root.unmount()) };
  act(() => root.render(<SourceControlToolsSection environment={environment} />));
  const rescan = container.querySelector("button")!;
  expect(rescan.disabled).toBe(true);

  tools.data = [];
  act(() => root.render(<SourceControlToolsSection environment={{ ...environment }} />));
  expect(rescan.disabled).toBe(false);
  await act(async () => rescan.click());
  expect(mocks.command).toHaveBeenCalledExactlyOnceWith({
    environmentId: environment.environmentId,
    input: {},
  });
});

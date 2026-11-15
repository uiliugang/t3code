import { EnvironmentId, ProjectId, ThreadId, type WechatState } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { mocks, Children, Action } = vi.hoisted(() => ({
  mocks: { state: null as WechatState | null, mutate: vi.fn() },
  Children: ({ children }: { children?: ReactNode }) => children,
  Action: ({
    label,
    description,
    disabled,
    loading,
    onPress,
  }: {
    label: string;
    description?: string;
    disabled?: boolean;
    loading?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled || loading} onClick={onPress}>
      {label}
      {description}
    </button>
  ),
}));

vi.mock("react-native", () => ({
  View: Children,
  ScrollView: Children,
  Linking: { openURL: vi.fn() },
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: Children }));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListEmptyComponent,
  }: {
    data: WechatState["targets"];
    renderItem: (info: { item: WechatState["targets"][number]; index: number }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
  }) => (
    <>
      {ListHeaderComponent}
      {data.length ? data.map((item, index) => renderItem({ item, index })) : ListEmptyComponent}
    </>
  ),
}));
vi.mock("react-native-svg", () => ({ default: Children, Path: Children, Rect: Children }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({ Button: Action }));
vi.mock("../../components/ui/ListRow", () => ({ ListRow: Action }));
vi.mock("../../components/ui/ListToggleRow", () => ({ ListToggleRow: () => null }));
vi.mock("../../components/ui/ThemedSwitch", () => ({ ThemedSwitch: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ confirm: vi.fn() }));
vi.mock("../../components/ui/Sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
}));
vi.mock("../../components/ui/KeyboardSheetBody", () => ({ KeyboardSheetBody: Children }));
vi.mock("../../components/ui/SelectionRow", () => ({
  SelectionRow: ({
    title,
    disabled,
    onPress,
  }: {
    title: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {title}
    </button>
  ),
}));
vi.mock("../connection/ConnectionFormField", () => ({
  ConnectionFormField: ({
    label,
    value,
    onChangeText,
  }: {
    label: string;
    value: string;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={label}
      value={value}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("../../lib/useUiTranslation", () => ({ useUiTranslation: () => (text: string) => text }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { wechat: () => null, mutateWechat: { permissionAtom: () => null } },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: mocks.state }) }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.mutate }));

import { WechatSettingsSection } from "./WechatSettingsSection";

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.mutate.mockReset();
  mocks.mutate.mockResolvedValue({ _tag: "Success" });
  mocks.state = {
    status: "connected",
    enabled: true,
    activated: true,
    botId: "bot",
    userId: "user",
    threadId: ThreadId.make("thread-0"),
    projectId: ProjectId.make("project"),
    pushEnabled: true,
    pushAllThreads: true,
    qrCode: null,
    bindingCode: null,
    expiresAt: null,
    error: null,
    deliveries: [],
    targets: Array.from({ length: 35 }, (_, index) => ({
      threadId: ThreadId.make(`thread-${index}`),
      projectId: ProjectId.make("project"),
      title: `Thread ${index}`,
    })),
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(<WechatSettingsSection environmentId={EnvironmentId.make("environment")} />),
  );
  const button = (label: string) => {
    const result = Array.from(container.querySelectorAll("button")).find((element) =>
      element.textContent?.startsWith(label),
    );
    expect(result, label).toBeDefined();
    return result!;
  };
  act(() => button("Target thread").click());
  return {
    container,
    button,
    search(value: string) {
      const input = container.querySelector("input")!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("lets users select a target beyond the first thirty threads", async () => {
  using screen = setup();
  await act(async () => screen.button("Thread 34").click());
  expect(mocks.mutate).toHaveBeenCalledWith({
    environmentId: "environment",
    input: { type: "configure", threadId: "thread-34", pushEnabled: true, pushAllThreads: true },
  });
  expect(screen.container.querySelector("input")).toBeNull();
});

it("retains the search and target picker until a configuration succeeds", async () => {
  using screen = setup();
  screen.search("Thread 2");
  let finish!: (result: { _tag: string }) => void;
  mocks.mutate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => screen.button("Thread 2").click());
  expect(screen.container.querySelector("input")?.value).toBe("Thread 2");
  expect(screen.button("Thread 2").disabled).toBe(true);
  await act(async () => finish({ _tag: "Failure" }));
  expect(screen.container.querySelector("input")?.value).toBe("Thread 2");
  expect(screen.container.querySelector('[role="dialog"]')?.textContent).toContain(
    "Could not update WeChat",
  );
  await act(async () => screen.button("Thread 2").click());
  expect(screen.container.querySelector("input")).toBeNull();
});

it("explains an empty search and restores results when the search is cleared", () => {
  using screen = setup();
  screen.search("does not exist");
  expect(screen.container.textContent).toContain("No matching threads");
  screen.search("");
  expect(screen.button("Thread 34")).toBeDefined();
});

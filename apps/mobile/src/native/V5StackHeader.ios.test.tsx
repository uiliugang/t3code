import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { StackHeaderConfigProps } from "react-native-screens";
import { expect, it, vi } from "vite-plus/test";

const bridge = vi.hoisted(() => ({
  ios: undefined as StackHeaderConfigProps["ios"],
  title: undefined as StackHeaderConfigProps["title"],
}));

vi.mock("react-native", () => ({ StyleSheet: { flatten: (style: unknown) => style } }));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { dismiss: vi.fn() },
  useKeyboardState: () => false,
}));
vi.mock("../lib/useMobileNavigationTheme", () => ({
  useMobileNavigationTheme: () => ({ colors: { card: "white" } }),
}));
vi.mock("../lib/useUiTranslation", () => ({
  useUiTranslation: () => {
    const labels = new Map([
      ["Files", "文件"],
      ["Terminal", "终端"],
      ["Open terminal", "打开终端"],
    ]);
    return (value: string) => labels.get(value) ?? value;
  },
}));
vi.mock("./native-layout-metrics", () => ({
  useDeviceType: () => "phone",
  useNativeLayoutMetrics: () => null,
}));
vi.mock("react-native-screens", () => ({
  Stack: {
    HeaderConfig: ({ ios, title }: StackHeaderConfigProps) => {
      bridge.ios = ios;
      bridge.title = title;
      return null;
    },
  },
}));

import { V5StackHeader } from "./V5StackHeader.ios";

it.each(["leadingItems", "trailingItems", "toolbarItems"] as const)(
  "updates native enabled state after permissions change in %s",
  (placement) => {
    bridge.ios = undefined;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(document.createElement("div"));
    const onPress = () => {};
    try {
      for (const disabled of [true, false, undefined, true]) {
        const items: NativeStackHeaderItem[] = [
          { type: "button", label: "文件", identifier: "open-files", disabled, onPress },
          {
            type: "menu",
            label: "终端",
            disabled,
            menu: { items: [{ type: "action", label: "打开终端", onPress }] },
          },
        ];
        act(() =>
          root.render(
            <V5StackHeader
              canGoBack={false}
              options={{
                unstable_headerLeftItems: () => (placement === "leadingItems" ? items : []),
                unstable_headerRightItems: () => (placement === "trailingItems" ? items : []),
                unstable_headerToolbarItems: () => (placement === "toolbarItems" ? items : []),
              }}
            />,
          ),
        );
        const nativeItems = (bridge.ios as StackHeaderConfigProps["ios"])?.[placement];
        expect(nativeItems).toHaveLength(2);
        expect(nativeItems?.[0]).toMatchObject({
          id: "open-files",
          identifier: "open-files",
          title: "文件",
        });
        expect(nativeItems?.[1]).toMatchObject({
          title: "终端",
        });
        if (!disabled)
          expect(nativeItems?.[1]).toMatchObject({
            menu: { children: [expect.objectContaining({ title: "打开终端" })] },
          });
        for (const item of nativeItems ?? []) {
          if (item.type !== "item" || "render" in item)
            throw new Error("Expected a native bar item");
          // RNSHeaderContentFactory sets UIBarButtonItem.enabled to !item.disabled.
          expect(!item.disabled).toBe(!disabled);
        }
      }
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it.each(["title", "headerTitle"] as const)("preserves user content in %s and menus", (titleKey) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const onPress = vi.fn();
  try {
    act(() =>
      root.render(
        <V5StackHeader
          canGoBack={false}
          options={{
            [titleKey]: "Files",
            unstable_headerRightItems: () => [
              {
                type: "menu",
                label: "Terminal",
                menu: {
                  title: "Files",
                  items: [
                    {
                      type: "submenu",
                      label: "Files",
                      items: [{ type: "action", label: "Open terminal", onPress }],
                    },
                  ],
                },
              },
            ],
          }}
        />,
      ),
    );
    expect(bridge.title).toBe("Files");
    expect(bridge.ios?.trailingItems?.[0]).toMatchObject({
      title: "Terminal",
      menu: {
        title: "Files",
        children: [
          {
            title: "Files",
            children: [expect.objectContaining({ title: "Open terminal", onPress })],
          },
        ],
      },
    });
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

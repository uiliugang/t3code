import { act, useImperativeHandle, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  ProjectSourceLine,
  ProjectSourceSwipeChange,
  useProjectSourceSwipes,
} from "./ProjectSourceLine";

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    accessibilityLabel,
    children,
    onPress,
  }: {
    accessibilityLabel: string;
    children: ReactNode;
    onPress: () => void;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("react-native-gesture-handler/ReanimatedSwipeable", () => ({
  default: function NativeSwipe({
    ref,
    children,
    onSwipeableWillOpen,
    onSwipeableWillClose,
    renderRightActions,
  }: {
    ref: Ref<{ close: () => void }>;
    children: ReactNode;
    onSwipeableWillOpen: () => void;
    onSwipeableWillClose: () => void;
    renderRightActions: () => ReactNode;
  }) {
    useImperativeHandle(ref, () => ({ close: onSwipeableWillClose }));
    return (
      <div onDoubleClick={onSwipeableWillOpen}>
        {children}
        {renderRightActions()}
      </div>
    );
  },
}));

it("exposes only the revealed source's action and closes it when write access changes", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const first = { name: "acme/web", edit: vi.fn() };
  const second = { name: "qa/tracker", edit: vi.fn() };
  function List({ writable }: { writable: boolean }) {
    const swipes = useProjectSourceSwipes();
    return (
      <ProjectSourceSwipeChange value={swipes.onChange}>
        {[first, second].map(({ name, edit }) => (
          <ProjectSourceLine
            key={name}
            value={name}
            detail={undefined}
            action="Edit"
            actionLabel={`Edit ${name}`}
            onEdit={writable ? edit : undefined}
          />
        ))}
      </ProjectSourceSwipeChange>
    );
  }
  const render = (writable: boolean) => act(() => root.render(<List writable={writable} />));
  const swipe = (index: number) =>
    act(() => {
      container.children[index]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
  const actions = () => [...container.querySelectorAll("button")];

  render(true);
  expect(actions()).toHaveLength(0);
  swipe(0);
  expect(actions().map((button) => button.getAttribute("aria-label"))).toEqual(["Edit acme/web"]);
  swipe(1);
  expect(actions().map((button) => button.getAttribute("aria-label"))).toEqual(["Edit qa/tracker"]);
  expect(second.edit).not.toHaveBeenCalled();
  act(() => actions()[0]!.click());
  expect(first.edit).not.toHaveBeenCalled();
  expect(second.edit).toHaveBeenCalledOnce();
  render(false);
  expect(actions()).toHaveLength(0);
  swipe(0);
  render(true);
  expect(actions()).toHaveLength(0);
});

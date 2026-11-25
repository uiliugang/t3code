import { EnvironmentId, ProjectId, type IssueSource } from "@t3tools/contracts";
import { translateUi, type UiTranslator } from "@t3tools/shared/uiLocale";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Children = { children?: ReactNode };
type Press = Children & { accessibilityLabel?: string; disabled?: boolean; onPress: () => void };
const { update } = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("react-native", () => ({
  View: ({ children }: Children) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
  AppTextInput: ({
    value,
    editable,
    onChangeText,
  }: {
    value: string;
    editable: boolean;
    onChangeText: (text: string) => void;
  }) => (
    <input
      disabled={!editable}
      value={value}
      onInput={(event) => onChangeText(event.currentTarget.value)}
      readOnly
    />
  ),
}));
vi.mock("../../components/ui/IconButton", () => ({
  IconButton: ({ accessibilityLabel, onPress }: Press) => (
    <button aria-label={accessibilityLabel} onClick={onPress} />
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, disabled, onPress }: Press & { label: string }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/ListRow", () => ({
  ListRow: ({ label, description, onPress }: Press & { label: string; description?: string }) => (
    <button onClick={onPress}>
      {label} {description}
    </button>
  ),
}));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: ({ label, description }: { label: string; description?: string }) => (
    <div>
      {label} {description}
    </div>
  ),
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: ({ children }: Children) => children,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: Children) => children,
}));
vi.mock("../../components/ui/Sheet", () => ({
  Sheet: ({ children }: Children) => <section>{children}</section>,
}));
vi.mock("../../lib/useUiTranslation", () => ({
  useUiTranslation: (): UiTranslator => (message, values) => translateUi("en", message, values),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => update }));

import { ProjectSourcesRow } from "./ProjectSourcesRow";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project");
const first: IssueSource = { provider: "github", host: "github.com", scope: "acme/app" };
const second: IssueSource = { provider: "github", host: "git.example.test", scope: "acme/app" };
const space: IssueSource = { provider: "meituan", host: "mep.sankuai.com", scope: "19002" };
const sources = [first, second];

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (
    allowed: boolean,
    saved: IssueSource[] = sources,
    singleProvider = true,
    mep = true,
    compareAndSet = true,
  ) =>
    act(() =>
      root.render(
        <ProjectSourcesRow
          environmentId={environmentId}
          projectId={projectId}
          title="server"
          repository="acme/app"
          saved={saved}
          singleProvider={singleProvider}
          compareAndSet={compareAndSet}
          sources={saved.filter((source) => source.provider === saved[0]?.provider)}
          provider={saved[0]?.provider}
          error={undefined}
          discovery="ready"
          mep={mep}
          allowed={allowed}
        />,
      ),
    );
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((node) =>
      [node.getAttribute("aria-label"), node.textContent].some((value) => value?.includes(text)),
    )!;
  return { container, render, button, [Symbol.dispose]: () => act(() => root.unmount()) };
}

it("opens one project editor and saves only the chosen host when repositories share a name", async () => {
  update.mockReset().mockResolvedValue({ _tag: "Success" });
  using screen = setup();
  screen.render(true);
  expect(screen.container.querySelectorAll("button")).toHaveLength(1);
  expect(screen.container.textContent).toContain("2 GitHub repositories");
  act(() => screen.container.querySelector("span")!.click());
  expect(screen.container.querySelector("section")).toBeNull();
  act(() => screen.button("Edit server").click());
  expect(screen.button("Not configured")).toBeUndefined();
  expect(screen.button("No MEP")).toBeUndefined();
  act(() => screen.button("git.example.test").click());
  const input = screen.container.querySelector("input")!;
  expect(input.value).toBe("acme/app");
  act(() => {
    input.value = "qa/reviewed";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => screen.button("Save").click());
  expect(update).toHaveBeenCalledOnce();
  expect(update).toHaveBeenCalledWith({
    environmentId,
    input: {
      issueSourceProvider: "github",
      expectedIssueProjectSources: { [projectId]: sources },
      patch: {
        issueProjectSources: { [projectId]: [first, { ...second, scope: "qa/reviewed" }] },
      },
    },
  });
  expect(screen.container.querySelector("section")).toBeNull();
});

it("keeps MEP spaces readable without offering a GitHub binding", () => {
  using screen = setup();
  screen.render(false, [space]);
  expect(screen.button("Edit server")).toBeUndefined();
  act(() => screen.button("server").click());
  const details = screen.container.querySelector("section")!;
  expect(details.textContent).not.toContain("Not configured");
  expect(details.textContent).toContain(space.scope);
  expect(details.querySelector("button, input")).toBeNull();
});

it("keeps legacy sources read-only without compare-and-set support", () => {
  update.mockReset();
  using screen = setup();
  screen.render(true, [first, space], false, true, false);
  act(() => screen.button("View sources for server").click());
  expect(screen.container.textContent).toContain(space.scope);
  expect(screen.button("Remove incompatible sources")).toBeUndefined();
  expect(screen.container.querySelector("section button, section input")).toBeNull();
  expect(update).not.toHaveBeenCalled();
});

it("allows restoring a ported GitHub source without letting an older server save it", async () => {
  update.mockReset().mockResolvedValue({ _tag: "Success" });
  using screen = setup();
  const ported = { ...second, host: "git.example.test:8443" };
  screen.render(true, [ported]);
  act(() => screen.button("Edit server").click());
  expect(screen.button("Save").disabled).toBe(true);
  await act(async () => screen.button("Restore automatic").click());
  expect(update).toHaveBeenCalledWith({
    environmentId,
    input: {
      issueSourceProvider: "github",
      expectedIssueProjectSources: { [projectId]: [ported] },
      patch: { issueProjectSources: { [projectId]: [] } },
    },
  });
});

it("restores automatic GitHub sources without removing MEP on a multi-provider server", async () => {
  update.mockReset().mockResolvedValue({ _tag: "Success" });
  using screen = setup();
  const legacy = [first, space];
  screen.render(true, legacy, false);
  act(() => screen.button("Edit server").click());
  act(() => screen.button("acme/app github.com").click());
  await act(async () => screen.button("Restore automatic").click());
  expect(update).toHaveBeenCalledWith({
    environmentId,
    input: {
      expectedIssueProjectSources: { [projectId]: legacy },
      patch: { issueProjectSources: { [projectId]: [space] } },
    },
  });
});

it("removes a legacy binding without losing either same-platform repository", async () => {
  update.mockReset().mockResolvedValue({ _tag: "Success" });
  using screen = setup();
  const legacy = [first, space, second];
  screen.render(true, legacy, false);
  act(() => screen.button("Edit server").click());
  expect(screen.container.textContent).toContain(space.scope);
  await act(async () => screen.button("Remove incompatible sources").click());
  expect(update).toHaveBeenCalledWith({
    environmentId,
    input: {
      expectedIssueProjectSources: { [projectId]: legacy },
      patch: { issueProjectSources: { [projectId]: sources } },
    },
  });
});

it("can clear a disabled MEP binding before choosing GitHub", async () => {
  update.mockReset().mockResolvedValue({ _tag: "Success" });
  using screen = setup();
  screen.render(true, [space], true, false);
  act(() => screen.button("Edit server").click());
  expect(screen.container.querySelector("input")).toBeNull();
  expect(screen.container.textContent).toContain(space.scope);
  await act(async () => screen.button("Restore automatic").click());
  expect(update).toHaveBeenCalledWith({
    environmentId,
    input: {
      expectedIssueProjectSources: { [projectId]: [space] },
      patch: { issueProjectSources: { [projectId]: [] } },
    },
  });
  screen.render(true, [], true, false);
  act(() => screen.button("Edit server").click());
  expect(screen.container.textContent).toContain("GitHub repository");
});

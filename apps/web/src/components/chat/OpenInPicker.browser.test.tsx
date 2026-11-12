import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type EditorId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, fakeTimers, render as renderUi } from "../../../test/render";
import type { RemoteOpenState } from "../../remoteOpen";

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  remote: { mode: "local-exec" } as RemoteOpenState,
  clientEditors: ["vscode"] as readonly EditorId[],
  run: vi.fn(),
  openUrl: vi.fn(),
  setPreferred: vi.fn(),
  markHintSeen: vi.fn(),
  listeners: new Set<() => void>(),
  worktreePath: null as string | null,
}));

vi.mock(import("../../state/session"), async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (environmentId: string, scope: string) =>
    (scope === AuthOrchestrationOperateScope ||
      scope === AuthTerminalOperateScope ||
      scope === AuthTerminalReadScope) &&
    state.allowed.has(environmentId);
  return {
    ...(await importOriginal()),
    readEnvironmentScope: readEnvironmentScope as never,
    useEnvironmentScope: ((environmentId: string, scope: string) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(environmentId, scope),
      )) as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => state.run) as never,
}));
vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironment: (() => ({ label: "Test host" })) as never,
}));
vi.mock(import("../../editorPreferences"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    usePreferredEditor: (available: readonly EditorId[]) => {
      const [preferred, setPreferred] = actual.usePreferredEditor(available);
      const recordPreferred: typeof setPreferred = (editor) => {
        state.setPreferred(editor);
        setPreferred(editor);
      };
      return [preferred, recordPreferred] as const;
    },
  };
});
vi.mock(import("../../remoteOpen"), async (importOriginal) => ({
  ...(await importOriginal()),
  useRemoteOpenState: () => state.remote,
  useRemoteCapableEditors: () => state.clientEditors,
  useRemoteOpenHint: () => [false, state.markHintSeen] as const,
  openRemoteEditorUrl: state.openUrl,
}));
vi.mock(import("../../state/entities"), () => ({
  useProject: (() => ({
    id: projectId,
    environmentId: selected,
    workspaceRoot: "/work/project",
  })) as never,
  useQuietThreadShell: (() => ({
    environmentId: selected,
    projectId,
    worktreePath: state.worktreePath,
  })) as never,
}));
vi.mock(import("../../state/terminalSessions"), () => ({ useKnownTerminalSessions: () => [] }));
vi.mock(import("../../hooks/useT3ProjectFileScripts"), () => ({
  useT3ProjectFileScripts: () => [],
}));
vi.mock(import("./ThreadDetailsCard"), () => ({
  ThreadDetailsCard: ({ children }: { children: (density: "full") => React.ReactNode }) => (
    <>{children("full")}</>
  ),
}));
vi.mock(import("../BranchToolbar"), () => ({ BranchToolbar: (() => <></>) as never }));
vi.mock(import("../GitActionsControl"), () => ({ default: () => null }));
vi.mock(import("../ProjectScriptsControl"), () => ({ default: () => <></> }));
vi.mock(import("./RepositoryDetails"), () => ({ RepositoryDetails: () => <></> }));
vi.mock(import("./BranchIssuesPanel"), () => ({ BranchIssuesPanel: () => null }));
vi.mock(import("./GroupedBranchIssuesPanel"), () => ({ GroupedBranchIssuesPanel: () => null }));
vi.mock(import("./WorkspaceRecoveryControl"), () => ({ WorkspaceRecoveryControl: () => <></> }));
vi.mock(import("./ThreadAutomationsPanel"), () => ({ ThreadAutomationsPanel: () => null }));
vi.mock(import("./ThreadRelationshipsControl"), () => ({ ThreadRelationshipsPanel: () => null }));
vi.mock(import("./ThreadServersPanel"), () => ({ ThreadServersPanel: () => <></> }));

import { __setClientSettingsForTests, persistClientSettingsPatch } from "../../hooks/useSettings";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadDetailsPanel } from "./ThreadDetailsPanel";
import { PopoverCreateHandle } from "../ui/popover";
import {
  registerOpenFavoriteEditorCommand,
  useOpenFavoriteEditorShortcut,
} from "./OpenInPickerShortcut";

const primary = EnvironmentId.make("primary");
const selected = EnvironmentId.make("selected");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const editors: readonly EditorId[] = ["vscode"];

async function setup() {
  state.allowed.clear();
  state.remote = { mode: "local-exec" };
  state.clientEditors = editors;
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.openUrl.mockReset().mockResolvedValue(true);
  state.setPreferred.mockReset();
  state.markHintSeen.mockReset();
  state.listeners.clear();
  state.worktreePath = null;
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    uiLanguage: "en",
    showRepositoryTerminalButton: false,
  });
  useRightPanelStore.setState({ byThreadKey: {} });
  useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: {} });
  window.localStorage.clear();

  await using stack = new AsyncDisposableStack();
  const _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
  stack.use(_platform);
  const _storage = { [Symbol.dispose]: () => window.localStorage.clear() };
  stack.use(_storage);
  // The app registers this command at startup (appInit).
  const _openFavorite = { [Symbol.dispose]: registerOpenFavoriteEditorCommand() };
  stack.use(_openFavorite);
  const screen = stack.use(await renderUi(null));
  async function renderPicker(
    availableEditors: readonly EditorId[] = editors,
    panel = false,
    { openInCwd = "/work/project", revealFileManager = false } = {},
  ) {
    await act(async () => {
      for (const listener of state.listeners) listener();
      const node = (
        <OpenInPicker
          environmentId={selected}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          availableEditors={availableEditors}
          openInCwd={openInCwd}
          revealFileManager={revealFileManager}
          displayMode={panel ? "panel" : "toolbar"}
          compact={!panel}
        />
      );
      await screen.rerender(node);
    });
  }

  function byLabel(label: string) {
    const element = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    expect(element, label).not.toBeNull();
    return element!;
  }

  const primaryButton = () => byLabel("Open file in preferred editor");
  const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];

  async function click(element: HTMLElement) {
    await act(async () => element.click());
  }

  async function pressOpenFavorite(mac = false) {
    const event = new KeyboardEvent("keydown", {
      key: "o",
      ctrlKey: !mac,
      metaKey: mac,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => document.body.dispatchEvent(event));
    return event;
  }

  function FavoriteEditorFallback() {
    useOpenFavoriteEditorShortcut({
      enabled: true,
      environmentId: selected,
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      availableEditors: editors,
      openInCwd: "/work/project",
    });
    return null;
  }

  const environment = stack.move();
  return {
    screen,
    renderPicker,
    byLabel,
    primaryButton,
    menuItems,
    click,
    pressOpenFavorite,
    FavoriteEditorFallback,
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

describe("host editor access", () => {
  it("uses the selected grant for both the button and a retained shortcut", async () => {
    await using fixture = await setup();
    const { renderPicker, byLabel, primaryButton, click, pressOpenFavorite } = fixture;
    state.allowed.add(selected);
    await renderPicker();
    // Revoke without rerendering to exercise execution-time grant checks.
    state.allowed.delete(selected);
    state.allowed.add(primary);
    await click(primaryButton());
    // The shortcut is consumed and opens nothing once the grant is gone.
    expect((await pressOpenFavorite()).defaultPrevented).toBe(true);
    expect(state.run).not.toHaveBeenCalled();
    expect(state.setPreferred).not.toHaveBeenCalled();

    await renderPicker();
    expect(primaryButton().disabled).toBe(true);
    expect(byLabel("Choose editor").disabled).toBe(true);
    expect((await pressOpenFavorite()).defaultPrevented).toBe(false);
  });
});

it.each([null, "/work/project-worktree"])(
  "opens a single-repository terminal with the setting enabled (worktree: %s)",
  async (worktreePath) => {
    await using fixture = await setup();
    state.allowed.add(selected);
    state.worktreePath = worktreePath;
    const cwd = worktreePath ?? "/work/project";
    const handle = PopoverCreateHandle();
    const panel = (showOpenInPicker: boolean) => (
      <ThreadDetailsPanel
        anchor={{ current: null }}
        handle={handle}
        environmentId={selected}
        threadId={threadId}
        composerDraftTarget={{ environmentId: selected, threadId }}
        workspaceMutationId={null}
        projectId={projectId}
        worktreePath={worktreePath}
        isServerThread
        activeProjectName="Project"
        activeProjectScripts={undefined}
        preferredScriptId={null}
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        availableEditors={editors}
        showOpenInPicker={showOpenInPicker}
        openInShortcutEnabled
        gitCwd={cwd}
        isGitRepo={false}
        envLocked
        availableEnvironments={[]}
        onEnvModeChange={() => {}}
        envMode={worktreePath ? "worktree" : "local"}
        startFromOrigin={false}
        onStartFromOriginChange={() => {}}
        onComposerFocusRequest={() => {}}
        onRunProjectScript={() => {}}
        onAddProjectScript={async () => AsyncResult.success(undefined)}
        onUpdateProjectScript={async () => AsyncResult.success(undefined)}
        onDeleteProjectScript={async () => AsyncResult.success(undefined)}
        usage={{ providerInstanceId: null, providers: [], sources: [], contextWindow: null }}
      />
    );
    await fixture.screen.rerender(panel(true));
    await fixture.click(fixture.byLabel("Choose editor"));
    await expect
      .element(page.getByRole("menuitem", { name: "Terminal", exact: true }))
      .not.toBeInTheDocument();
    await fixture.click(fixture.byLabel("Choose editor"));

    await act(() =>
      persistClientSettingsPatch({ showRepositoryTerminalButton: true }, async () => {}),
    );
    await fixture.click(fixture.byLabel("Choose editor"));
    await page.getByRole("menuitem", { name: "Terminal", exact: true }).click();
    expect(state.run).toHaveBeenCalledExactlyOnceWith({
      environmentId: selected,
      input: {
        threadId,
        terminalId: "term-1",
        cwd,
        ...(worktreePath ? { worktreePath } : {}),
        env: {
          T3CODE_PROJECT_ROOT: "/work/project",
          ...(worktreePath ? { T3CODE_WORKTREE_PATH: worktreePath } : {}),
        },
      },
    });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, {
        environmentId: selected,
        threadId,
      }).surfaces,
    ).toEqual([expect.objectContaining({ kind: "terminal", terminalIds: ["term-1"] })]);

    await fixture.screen.rerender(panel(false));
    await expect.element(page.getByRole("button", { name: "Choose editor" })).toBeVisible();
    await act(() =>
      persistClientSettingsPatch({ threadDetailsItems: { openIn: false } }, async () => {}),
    );
    await expect
      .element(page.getByRole("button", { name: "Choose editor" }))
      .not.toBeInTheDocument();
    await act(() => persistClientSettingsPatch({ threadDetailsItems: {} }, async () => {}));
    await expect.element(page.getByRole("button", { name: "Choose editor" })).toBeVisible();
    await act(() =>
      persistClientSettingsPatch({ showRepositoryTerminalButton: false }, async () => {}),
    );
    await expect
      .element(page.getByRole("button", { name: "Choose editor" }))
      .not.toBeInTheDocument();
  },
);

describe("remote editor links", () => {
  it("opens the link from the fallback when the picker is not mounted", async () => {
    await using fixture = await setup();
    const { screen, pressOpenFavorite, FavoriteEditorFallback } = fixture;
    state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "sol" } };
    // A successful open would announce on a real timer that fires in the next test.
    state.openUrl.mockResolvedValueOnce(false);
    await act(async () => screen.rerender(<FavoriteEditorFallback />));

    expect((await pressOpenFavorite()).defaultPrevented).toBe(true);
    expect(state.openUrl).toHaveBeenCalledWith(expect.stringContaining("ssh-remote+sol"));
    expect(state.run).not.toHaveBeenCalled();
  });

  it("explains why a phone or tablet browser has no editor to open", async () => {
    await using fixture = await setup();
    const { renderPicker, byLabel, primaryButton, menuItems, click, pressOpenFavorite } = fixture;
    state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "sol" } };
    state.clientEditors = [];
    await renderPicker();

    expect(primaryButton().disabled).toBe(true);
    expect((await pressOpenFavorite()).defaultPrevented).toBe(false);
    await click(byLabel("Choose editor"));
    await vi.waitFor(() =>
      expect(menuItems().map((item) => item.textContent)).toEqual([
        "Open from a computer to edit on Test host",
      ]),
    );
    expect(menuItems()[0]!.getAttribute("aria-disabled")).toBe("true");
    expect(state.openUrl).not.toHaveBeenCalled();
  });
});

describe("open in editor announcement", () => {
  it("speaks only after the shortcut opened the editor, from the picker or the fallback", async () => {
    await using fixture = await setup();
    const { screen, renderPicker, pressOpenFavorite, FavoriteEditorFallback } = fixture;
    state.allowed.add(selected);
    await renderPicker();
    using _timers = fakeTimers();
    const regions = () => [...document.querySelectorAll('body > [aria-live="polite"]')];
    const spoken = async () => {
      await act(async () => vi.runAllTimers());
      return regions()
        .map((region) => region.textContent)
        .join("");
    };
    const refuse = () =>
      state.run.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("No editor"))));

    refuse();
    await pressOpenFavorite();
    expect(await spoken()).toBe("");
    await pressOpenFavorite();
    expect(await spoken()).toBe("Opened in VS Code");

    for (const region of regions()) region.textContent = "";
    await act(async () => screen.rerender(<FavoriteEditorFallback />));
    refuse();
    await pressOpenFavorite();
    expect(await spoken()).toBe("");
    await pressOpenFavorite();
    expect(await spoken()).toBe("Opened in VS Code");
  });
});

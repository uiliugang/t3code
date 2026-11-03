import { EnvironmentId, ThreadId, type ProjectReadFileResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  file: null as ProjectReadFileResult | null,
  optimistic: null as ProjectReadFileResult | null,
  writeFile: vi.fn(),
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: ((_registry: unknown, _command: unknown, request: unknown) =>
    state.writeFile(request)) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.writeFile) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("~/remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenState: () => ({ mode: "local-exec" }) as never,
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () => ({ resolvedTheme: "dark" }) as never,
}));
vi.mock(import("~/hooks/useWorkspaceMutationRefresh"), () => ({
  useWorkspaceMutationRefresh: vi.fn(),
}));
vi.mock(import("./FileBreadcrumbs"), () => ({ FileBreadcrumbs: () => <></> }));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  useProjectFileQuery: () => ({
    data: state.file,
    error: null,
    isPending: false,
    readError: null,
    isNotFile: false,
    isFile: true,
    refresh: vi.fn(),
  }),
  getOptimisticProjectFileQueryData: () => state.optimistic,
  getUnsavedProjectFileQueryData: () => null,
  setProjectFileQueryData: (
    _environmentId: EnvironmentId,
    _cwd: string,
    relativePath: string,
    contents: string,
  ) => {
    state.optimistic = { relativePath, contents, truncated: false, byteLength: contents.length };
  },
  confirmProjectFileQueryData: () => true,
}));

import FilePreviewPanel from "./FilePreviewPanel";

const environmentId = EnvironmentId.make("markdown-preview-test");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };
function setup(renderMarkdown: boolean | null = null) {
  const keys = ["t3code.fileExplorerOpen", "t3code.renderMarkdown"];
  const previous = keys.map((key) => localStorage.getItem(key));
  localStorage.setItem(keys[0]!, "false");
  if (renderMarkdown === null) localStorage.removeItem(keys[1]!);
  else localStorage.setItem(keys[1]!, JSON.stringify(renderMarkdown));
  state.optimistic = null;
  state.writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  return {
    [Symbol.dispose]() {
      for (const [index, key] of keys.entries()) {
        const value = previous[index];
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    },
  };
}

function markdownPreview(
  truncated: boolean,
  {
    relativePath = "tasks.md",
    revealLine = null,
    revealRequestId = 0,
  }: { relativePath?: string; revealLine?: number | null; revealRequestId?: number } = {},
) {
  state.file = {
    relativePath,
    contents: "- [ ] Keep the rest of this file\n",
    byteLength: truncated ? 1_200_000 : 32,
    truncated,
  };
  return (
    <FilePreviewPanel
      environmentId={environmentId}
      cwd="/workspace"
      projectName="Project"
      relativePath={relativePath}
      threadRef={threadRef}
      composerDraftTarget={threadRef}
      keybindings={[]}
      availableEditors={[]}
      openInShortcutEnabled={false}
      revealLine={revealLine}
      revealRequestId={revealRequestId}
      onOpenFile={vi.fn()}
      onNavigateFolder={vi.fn()}
      folderTrail={undefined}
      onPendingChange={vi.fn()}
      selectedFilePending={false}
      workspaceMutationId={null}
    />
  );
}

describe("rendered Markdown task saves", () => {
  it("keeps a truncated read read-only without queuing a replacement", async () => {
    using _settings = setup();
    await using screen = await render(markdownPreview(true));
    using _timers = fakeTimers();
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.readOnly).toBe(true);
    await act(async () => checkbox.click());
    await vi.advanceTimersByTimeAsync(500);
    expect(checkbox.checked).toBe(false);
    expect(state.optimistic).toBeNull();
    expect(state.writeFile).not.toHaveBeenCalled();
  });

  it.each([null, false, true])(
    "still toggles and saves tasks with legacy preference %s",
    async (preference) => {
      using _settings = setup(preference);
      await using screen = await render(markdownPreview(false));
      using _timers = fakeTimers();
      const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      expect(checkbox).not.toBeNull();
      expect(checkbox.disabled).toBe(false);
      await act(async () => checkbox.click());
      await vi.advanceTimersByTimeAsync(500);
      expect(state.writeFile).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: {
          cwd: "/workspace",
          relativePath: "tasks.md",
          contents: "- [x] Keep the rest of this file\n",
        },
      });
    },
  );

  it("keeps Source local to the current file opening", async () => {
    using _settings = setup();
    await using screen = await render(markdownPreview(false));
    await screen.getByRole("button", { name: "Show markdown source", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "Show rendered markdown", exact: true }))
      .toBeVisible();
    await screen.rerender(markdownPreview(false));
    await expect
      .element(screen.getByRole("button", { name: "Show rendered markdown", exact: true }))
      .toBeVisible();
    await screen.rerender(markdownPreview(false, { relativePath: "other.md" }));
    await expect
      .element(screen.getByRole("button", { name: "Show markdown source", exact: true }))
      .toBeVisible();
    await screen.rerender(markdownPreview(false));
    await expect
      .element(screen.getByRole("button", { name: "Show markdown source", exact: true }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Show markdown source", exact: true }).click();
    await screen.rerender(markdownPreview(false, { revealRequestId: 1 }));
    await expect
      .element(screen.getByRole("button", { name: "Show markdown source", exact: true }))
      .toBeVisible();
    expect(localStorage.getItem("t3code.renderMarkdown")).toBeNull();
  });

  it("renders first-line links while preserving specific source-line reveals", async () => {
    using _settings = setup();
    await using screen = await render(
      markdownPreview(false, { revealLine: 1, revealRequestId: 1 }),
    );
    await expect
      .element(screen.getByRole("button", { name: "Show markdown source", exact: true }))
      .toBeVisible();
    await screen.rerender(markdownPreview(false, { revealLine: 2, revealRequestId: 2 }));
    await expect
      .element(screen.getByRole("button", { name: "Show rendered markdown", exact: true }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Show rendered markdown", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "Show markdown source", exact: true }))
      .toBeVisible();
    await screen.rerender(markdownPreview(false, { revealLine: 2, revealRequestId: 3 }));
    await expect
      .element(screen.getByRole("button", { name: "Show rendered markdown", exact: true }))
      .toBeVisible();
  });
});

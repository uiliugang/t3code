import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ClientSettings,
  type ReviewBranchCommitsResult,
  type ReviewDiffPreviewResult,
  type ReviewDiffPreviewSource,
  type ScopedThreadRef,
  type VcsListRefsResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { makeThreadFixture } from "~/test-fixtures";

type ResultAtom<A> = Atom.Atom<AsyncResult.AsyncResult<A, Error>>;

const state = vi.hoisted(() => ({
  thread: null as ReturnType<typeof makeThreadFixture> | null,
  threadRef: null as ScopedThreadRef | null,
  previews: new Map<string | null, ResultAtom<ReviewDiffPreviewResult>>(),
  filePatches: new Map<string, ResultAtom<ReviewDiffPreviewSource>>(),
  diffFilesCollapsed: false,
  config: null as unknown as Atom.Atom<null>,
  status: null as unknown as ResultAtom<VcsStatusResult>,
  localRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  remoteRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  commits: null as unknown as ResultAtom<ReviewBranchCommitsResult>,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: () => state.config },
}));
vi.mock("~/state/review", () => ({
  reviewEnvironment: {
    diffPreview: ({ input }: { input: { baseRef?: string } }) =>
      state.previews.get(input.baseRef ?? null)!,
    branchCommits: () => state.commits,
    diffFilePatch: ({ input }: { input: { request: { file: { path: string } } } }) =>
      state.filePatches.get(input.request.file.path)!,
    diffFileContents: {},
  },
}));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: {
    status: () => state.status,
    listRefs: ({ input }: { input: { refKind: "local" | "remote" } }) =>
      input.refKind === "local" ? state.localRefs : state.remoteRefs,
  },
}));
vi.mock("~/state/entities", () => ({
  useQuietThreadShell: () => state.thread,
  useProject: () => ({ workspaceRoot: "/project", repositoryIdentity: null }),
  useThreadCheckpointSummaries: () => [],
  useQuietThreadVisibleTurnItems: () => [],
}));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("~/hooks/useThreadRouteTarget", () => ({ useThreadRouteRef: () => state.threadRef }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: ClientSettings) => unknown) =>
    select({
      ...DEFAULT_CLIENT_SETTINGS,
      uiLanguage: "en",
      diffFilesCollapsed: state.diffFilesCollapsed,
    }),
  updateClientSettings: async () => {},
}));
vi.mock("~/hooks/useTheme", () => ({
  useRenderedAppearance: () => "dark",
  getRenderedAppearance: () => "dark",
  subscribeRenderedAppearance: () => () => {},
}));
vi.mock("~/state/queries", () => ({
  useCheckpointDiff: () => ({ data: null, error: null, isPending: false }),
  useTurnItemDetail: () => ({ data: null, error: null, isPending: false }),
  useDebouncedValue: <A,>(value: A) => value,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => {} }));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => async () => {} }));
vi.mock("~/fileContextMenu", () => ({ useFileContextMenuHandler: () => () => {} }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => async () => {} }));
// The test drives comparison controls, without mounting virtualized diff viewers or their workers.
vi.mock("./diffs/AnnotatableCodeView", () => ({
  AnnotatableCodeView: ({ files }: { files: Array<{ filePath: string; collapsed: boolean }> }) => (
    <div aria-label="Previewed diff">
      {files.map((file) => (
        <span key={file.filePath}>
          {file.filePath}:{file.collapsed ? "collapsed" : "expanded"}
        </span>
      ))}
    </div>
  ),
}));
vi.mock("./diffs/DiffFileTree", () => ({
  DiffFileTree: ({
    entries,
    onSelectFile,
  }: {
    entries: Array<{ path: string }>;
    onSelectFile: (path: string) => void;
  }) => (
    <nav aria-label="Changed files">
      {entries.map((entry) => (
        <button key={entry.path} onClick={() => onSelectFile(entry.path)}>
          {entry.path}
        </button>
      ))}
    </nav>
  ),
}));
vi.mock("./DiffFilePathCopyButton", () => ({ DiffFilePathCopyButton: () => null }));

import DiffPanel from "./DiffPanel";
import { useDiffPanelSessionStore, useDiffPanelStore } from "~/diffPanelStore";

const cwd = "/project-worktree";
const errorMessage = "Could not find a common commit between 'origin/orphan' and HEAD.";

function preview(): ReviewDiffPreviewResult {
  return {
    cwd,
    generatedAt: DateTime.makeUnsafe("2026-10-30T00:00:00Z"),
    sources: [
      {
        id: "branch",
        kind: "branch-range",
        title: "Changes",
        baseRef: "main",
        headRef: "dev",
        diff: "",
        diffHash: "empty",
        truncated: false,
        patchesDeferred: true,
        files: [],
      },
    ],
  };
}

function setup(failedBaseRef: string | null) {
  const reset = () => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
    state.filePatches.clear();
  };
  reset();
  state.diffFilesCollapsed = false;
  const patch = Atom.make<AsyncResult.AsyncResult<ReviewDiffPreviewSource, Error>>(
    AsyncResult.initial(),
  );
  state.threadRef = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
  };
  state.thread = makeThreadFixture({
    ...state.threadRef,
    id: state.threadRef.threadId,
    projectId: ProjectId.make("project"),
    branch: "dev",
    worktreePath: cwd,
  });
  state.previews.clear();
  state.previews.set(null, Atom.make(AsyncResult.success(preview())));
  state.previews.set("main", Atom.make(AsyncResult.success(preview())));
  state.previews.set(failedBaseRef, Atom.make(AsyncResult.fail(new Error(errorMessage))));
  state.config = Atom.make(null);
  state.status = Atom.make(
    AsyncResult.success({
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "dev",
      hasWorkingTreeChanges: false,
      workingTree: { rootPath: cwd, files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    }),
  );
  const refs = (names: string[], isRemote: boolean): VcsListRefsResult => ({
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: null,
    totalCount: names.length,
    refs: names.map((name) => ({
      name,
      isRemote,
      ...(isRemote ? { remoteName: "origin" } : {}),
      current: name === "dev",
      isDefault: name === "main",
      worktreePath: null,
    })),
  });
  state.localRefs = Atom.make(AsyncResult.success(refs(["dev", "main"], false)));
  state.remoteRefs = Atom.make(AsyncResult.success(refs(["origin/orphan"], true)));
  state.commits = Atom.make(AsyncResult.success({ commits: [], truncated: false }));
  useDiffPanelStore.getState().selectBranchBaseRef(state.threadRef, failedBaseRef);
  const registry = AtomRegistry.make();
  return {
    registry,
    patch,
    threadRef: state.threadRef,
    [Symbol.dispose]() {
      registry.dispose();
      reset();
    },
  };
}

it.each([
  {
    name: "a saved unrelated branch",
    failedBaseRef: "origin/orphan",
    recovery: "Automatic",
    baseRef: null,
  },
  {
    name: "an automatic base with unrelated history",
    failedBaseRef: null,
    recovery: "main",
    baseRef: "main",
  },
])(
  "recovers from $name without leaving the diff panel",
  async ({ failedBaseRef, recovery, baseRef }) => {
    using context = setup(failedBaseRef);
    await using screen = await render(
      <RegistryContext.Provider value={context.registry}>
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByText(errorMessage, { exact: true })).toBeVisible();
    const selector = screen.getByRole("combobox", { name: /Change comparison target/ });
    await vi.waitFor(() => expect(selector.query()).not.toBeNull());
    await userEvent.click(selector);
    await expect.element(page.getByRole("option", { name: "main", exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("option", { name: recovery, exact: true }));
    await expect.element(screen.getByText("No net changes in this selection.")).toBeVisible();
    await expect.element(screen.getByText(errorMessage, { exact: true })).not.toBeInTheDocument();
    const key = scopedThreadKey(context.threadRef);
    await vi.waitFor(() => {
      expect(useDiffPanelStore.getState().byThreadKey[key]).toEqual({ kind: "branch", baseRef });
      expect(useDiffPanelStore.getState().branchBaseRefByThreadKey[key]).toBe(baseRef);
    });
  },
);

it("previews the first file, switches from the tree, and falls back when the file disappears", async () => {
  using context = setup(null);
  const patch = (paths: string[]) =>
    paths
      .map(
        (path) =>
          `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
      )
      .join("");
  const result = preview();
  const previewAtom = Atom.make(AsyncResult.success(result));
  state.previews.set(null, previewAtom);
  const setFiles = (paths: string[]) =>
    context.registry.set(
      previewAtom,
      AsyncResult.success({
        ...result,
        sources: result.sources.map((source) => ({ ...source, diff: patch(paths) })),
      }),
    );
  setFiles(["a.ts", "b.ts"]);
  localStorage.removeItem("t3code.diffFileTreeOpen");
  localStorage.setItem("t3code.diffHideTestFiles", "true");
  localStorage.removeItem("t3code.diffHideMarkdownFiles");
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
    </RegistryContext.Provider>,
  );
  await expect.element(screen.getByText("a.ts:expanded", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Filter files", exact: true }));
  const legacyTestFilter = page.getByRole("menuitemcheckbox", {
    name: "Hide test files",
    exact: true,
  });
  await expect.element(legacyTestFilter).toHaveAttribute("aria-checked", "true");
  await userEvent.click(legacyTestFilter);
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByText("b.ts:expanded", { exact: true })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "b.ts", exact: true }));
  await expect.element(screen.getByText("b.ts:expanded", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("a.ts:expanded", { exact: true })).not.toBeInTheDocument();
  setFiles(["a.ts"]);
  await expect.element(screen.getByText("a.ts:expanded", { exact: true })).toBeVisible();
  const paths = ["a0.test.ts", "a1.test.ts", "a2.test.ts", "a3.test.ts", "guide.MD", "z.ts"];
  const source = {
    ...result.sources[0]!,
    diffHash: "large-preview",
    truncated: true,
    files: paths.map((path) => ({ path, previousPath: null, additions: 1, deletions: 1 })),
  };
  for (const path of paths) {
    state.filePatches.set(
      path,
      Atom.make(AsyncResult.success({ ...source, diff: patch([path]), truncated: false })),
    );
  }
  context.registry.set(previewAtom, AsyncResult.success({ ...result, sources: [source] }));
  await expect.element(screen.getByText("a0.test.ts:expanded", { exact: true })).toBeVisible();
  const toggleFilter = async (name: string) => {
    await userEvent.click(screen.getByRole("button", { name: "Filter files", exact: true }));
    await userEvent.click(page.getByRole("menuitemcheckbox", { name, exact: true }));
    await userEvent.keyboard("{Escape}");
  };
  await toggleFilter("Hide test files");
  await expect.element(screen.getByText("guide.MD:expanded", { exact: true })).toBeVisible();
  await toggleFilter("Hide .md files");
  await expect.element(screen.getByText("z.ts:expanded", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "guide.MD", exact: true }))
    .not.toBeInTheDocument();
  setFiles(["guide.MD", "a0.test.ts"]);
  await expect.element(screen.getByText("All files are hidden by filters.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Show all files", exact: true }));
  await expect.element(screen.getByText("a0.test.ts:expanded", { exact: true })).toBeVisible();
});

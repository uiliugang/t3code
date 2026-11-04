import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, type ProjectFolderCandidate } from "@t3tools/contracts";
import { Atom, AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { projectFolderImportAtom, type ProjectFolderImportRequest } from "../projectFolderImport";
import { ProjectFolderImportDialog } from "./ProjectFolderImportDialog";
import "../index.css";

const state = vi.hoisted(() => ({
  permission: null as Atom.Atom<boolean> | null,
  importFolders: vi.fn(),
}));

vi.mock(import("../projectFolderImport"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { projectFolderImportAtom: Atom.make<ProjectFolderImportRequest | null>(null) };
});
vi.mock(import("../hooks/useUiTranslation"), () => ({
  useUiTranslation: () => (text: string) => text,
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => localId,
  useEnvironments: () => ({ environments }),
}));
vi.mock("../state/filesystem", () => ({
  filesystemEnvironment: {
    browse: (request: { environmentId: EnvironmentId; input: { partialPath: string } }) => ({
      kind: "browse",
      ...request,
    }),
  },
}));
vi.mock("../state/projects", () => ({
  projectEnvironment: {
    importFolders: { permissionAtom: () => state.permission! },
    inspectFolders: (request: { environmentId: EnvironmentId; input: { paths: string[] } }) => ({
      kind: "inspect",
      ...request,
    }),
  },
}));
vi.mock(import("../state/use-atom-command"), () => ({
  useAtomCommand: () => state.importFolders,
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (
    query:
      | { kind: "browse"; environmentId: EnvironmentId; input: { partialPath: string } }
      | { kind: "inspect"; environmentId: EnvironmentId; input: { paths: string[] } }
      | null,
  ) => ({
    data:
      query?.kind === "browse"
        ? {
            parentPath: query.input.partialPath,
            entries: (folders.get(`${query.environmentId}:${query.input.partialPath}`) ?? []).map(
              (entry) => ({ name: entry.title, fullPath: entry.path }),
            ),
          }
        : query?.kind === "inspect"
          ? [...folders.entries()]
              .filter(([key]) => key.startsWith(`${query.environmentId}:`))
              .flatMap(([, entries]) => entries)
              .filter((entry) => query.input.paths.includes(entry.path))
          : null,
    isPending: false,
    error: null,
    refresh: () => {},
  }),
}));

const localId = EnvironmentId.make("local");
const remoteId = EnvironmentId.make("remote");
const environments = [localId, remoteId].map((environmentId) => ({
  environmentId,
  label: environmentId,
  connection: { phase: "connected" },
  serverConfig: { settings: { addProjectBaseDirectory: "/work/" } },
}));
const folder = (path: string, repositoryKey: string | null = null): ProjectFolderCandidate => ({
  path,
  title: path.split("/").at(-1)!,
  workspaceRoot: path,
  repositoryKey,
  existingProjectId: null,
  matchingRepositoryProjectId: null,
  error: null,
});
const folders = new Map([
  [
    "local:/work/",
    [
      { ...folder("/work/current"), existingProjectId: ProjectId.make("current") },
      folder("/work/alpha", "host/team/alpha"),
      folder("/work/alias", "host/team/alpha"),
      folder("/work/beta"),
    ],
  ],
  ["local:/other/", [folder("/other/gamma")]],
  ["remote:/work/", [folder("/work/remote")]],
]);

function setup(request: ProjectFolderImportRequest) {
  state.permission = Atom.make(true);
  state.importFolders.mockReset().mockResolvedValue(AsyncResult.success([]));
  const registry = AtomRegistry.make();
  registry.set(projectFolderImportAtom, request);
  return { registry, [Symbol.dispose]: () => registry.dispose() };
}

it("toggles the filtered selection without losing folders selected in other directories", async () => {
  using scope = setup({ environmentId: localId, parentPath: "/work/" });
  await using _screen = await render(
    <RegistryContext.Provider value={scope.registry}>
      <ProjectFolderImportDialog />
    </RegistryContext.Provider>,
  );
  const selectAll = page.getByRole("checkbox", { name: "Select available", exact: true });
  await userEvent.click(selectAll);
  await expect.element(page.getByRole("button", { name: "Import projects (2)" })).toBeEnabled();
  await expect
    .element(page.getByRole("checkbox", { name: "Select folder current" }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("checkbox", { name: "Select folder alias" }))
    .not.toBeChecked();

  await userEvent.fill(page.getByRole("textbox", { name: "Folder path" }), "/other/");
  await userEvent.keyboard("{Enter}");
  await userEvent.click(selectAll);
  await expect.element(page.getByRole("button", { name: "Import projects (3)" })).toBeEnabled();
  await userEvent.click(selectAll);
  await expect.element(page.getByRole("button", { name: "Import projects (2)" })).toBeEnabled();

  await userEvent.fill(page.getByRole("textbox", { name: "Folder path" }), "/work/");
  await userEvent.keyboard("{Enter}");
  await userEvent.fill(page.getByRole("textbox", { name: "Filter folders" }), "alpha");
  await userEvent.click(selectAll);
  await expect.element(page.getByRole("button", { name: "Import projects (1)" })).toBeEnabled();
  await userEvent.fill(page.getByRole("textbox", { name: "Filter folders" }), "");
  await expect.element(page.getByRole("checkbox", { name: "Select folder beta" })).toBeChecked();
});

it("opens the requested environment and clears its selection when a group jumps to another environment", async () => {
  using scope = setup({
    environmentId: remoteId,
    locations: [
      { environmentId: localId, parentPath: "/work/", title: "local repo" },
      { environmentId: remoteId, parentPath: "/work/", title: "remote repo" },
    ],
  });
  await using _screen = await render(
    <RegistryContext.Provider value={scope.registry}>
      <ProjectFolderImportDialog />
    </RegistryContext.Provider>,
  );
  await userEvent.click(page.getByRole("checkbox", { name: "Select folder remote" }));
  await userEvent.click(page.getByRole("button", { name: "Sibling folders" }));
  await userEvent.click(page.getByRole("menuitem", { name: /^local repo/ }));
  await expect.element(page.getByRole("checkbox", { name: "Select folder alpha" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Import projects (0)" })).toBeDisabled();
});

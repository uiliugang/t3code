import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, WorkspaceRootId } from "@t3tools/contracts";
import {
  buildRootsFromSelectedProjects,
  deriveAdhocGroupLogicalKey,
  resolveDraftProjectSelection,
  workspaceCreateInput,
  workspaceCreationError,
  type GroupableProject,
} from "./createWorkspace";

const frontend = {
  id: WorkspaceRootId.make("frontend"),
  alias: " frontend ",
  sourcePath: " /code/frontend/ ",
  description: " Web UI ",
  accessIntent: "write" as const,
  defaultSelected: true,
};
const backend = {
  ...frontend,
  id: WorkspaceRootId.make("backend"),
  alias: "backend",
  sourcePath: "/code/backend",
  description: "API",
};
const input = {
  projectId: ProjectId.make("workspace"),
  title: " Product ",
  roots: [frontend, backend],
  primaryRootId: backend.id,
};

describe("group creation", () => {
  it("creates the complete group with the selected primary directory and preserves source roots", () => {
    const created = workspaceCreateInput(input);
    expect(created.title).toBe("Product");
    expect(created.workspaceRoot).toBe("/code/backend");
    expect(created.createWorkspaceRootIfMissing).toBe(false);
    expect(
      created.workspaceConfig?.roots.map((root) => [root.alias, root.sourcePath, root.description]),
    ).toEqual([
      ["frontend", "/code/frontend/", "Web UI"],
      ["backend", "/code/backend", "API"],
    ]);
    expect(input.roots[0]?.alias).toBe(" frontend ");
    expect(
      workspaceCreateInput({ ...input, roots: [frontend], primaryRootId: frontend.id }),
    ).toMatchObject({
      title: "Product",
      workspaceRoot: "/code/frontend/",
      workspaceConfig: {
        primaryRootId: frontend.id,
        roots: [
          {
            id: frontend.id,
            alias: "frontend",
            sourcePath: "/code/frontend/",
            description: "Web UI",
            defaultSelected: true,
          },
        ],
      },
    });
  });

  it.each([
    [{ ...input, title: "  " }, "Enter a group name."],
    [{ ...input, roots: [] }, "Choose between 1 and 16 repositories."],
    [
      { ...input, roots: Array.from({ length: 17 }, () => frontend) },
      "Choose between 1 and 16 repositories.",
    ],
    [
      { ...input, roots: [frontend, { ...backend, sourcePath: " " }] },
      "Enter a name and directory for every repository.",
    ],
    [
      { ...input, roots: [frontend, { ...backend, alias: "frontend" }] },
      "Repository names must be unique.",
    ],
    [
      { ...input, roots: [frontend, { ...backend, sourcePath: "/code/frontend" }] },
      "Choose each repository directory only once.",
    ],
    [
      {
        ...input,
        roots: [
          { ...frontend, sourcePath: "C:\\code\\app\\" },
          { ...backend, sourcePath: "c:/CODE/app" },
        ],
      },
      "Choose each repository directory only once.",
    ],
    [{ ...input, primaryRootId: WorkspaceRootId.make("missing") }, "Choose a primary repository."],
  ] as const)("rejects an invalid group before creating any project: %j", (draft, message) => {
    expect(workspaceCreationError(draft)).toBe(message);
    expect(() => workspaceCreateInput(draft)).toThrow(message);
  });
});

const environmentId = EnvironmentId.make("local");
const project = (name: string): GroupableProject => ({
  id: ProjectId.make(name),
  environmentId,
  title: name,
  workspaceRoot: `/code/${name}`,
});

describe("draft project selection", () => {
  it("keeps single projects and resolves combinations without creating a project", () => {
    const a = project("frontend");
    const b = project("backend");
    expect(resolveDraftProjectSelection([a], [a, b])).toMatchObject({ kind: "single", project: a });
    const combined = resolveDraftProjectSelection([a, b], [a, b]);
    expect(combined).toMatchObject({
      kind: "adhoc-group",
      title: "frontend + backend",
      primaryProjectRef: { environmentId, projectId: a.id },
      selectedProjectIds: [a.id, b.id],
    });
    const roots = buildRootsFromSelectedProjects([a, b])!;
    const existing: GroupableProject = {
      ...project("saved-group"),
      workspaceConfig: { ...roots, version: 1 },
    };
    expect(resolveDraftProjectSelection([a, b], [a, b, existing])).toMatchObject({
      kind: "existing-group",
      project: existing,
    });
    expect(resolveDraftProjectSelection([b, a], [a, b, existing])?.kind).toBe("adhoc-group");
    expect(
      resolveDraftProjectSelection([a, b], [a, b, { ...existing, archivedAt: "2026-01-01" }])?.kind,
    ).toBe("adhoc-group");
  });

  it("expands groups, deduplicates paths, and preserves root configuration", () => {
    const a = project("frontend");
    const b = project("backend");
    const script = {
      id: "setup",
      name: "Setup",
      command: "vp i",
      icon: "configure" as const,
      runOnWorktreeCreate: true,
    };
    const group: GroupableProject = {
      ...project("group"),
      workspaceConfig: {
        version: 1,
        primaryRootId: backend.id,
        roots: [
          { ...frontend, accessIntent: "read_only", defaultBaseRef: "main", setupScript: script },
          backend,
        ],
      },
    };
    const result = buildRootsFromSelectedProjects(
      [group, a, b, { ...project("other"), title: "backend" }],
      { includeSetupScripts: true },
    )!;
    expect(result.roots).toHaveLength(3);
    expect(new Set(result.roots.map((root) => root.alias)).size).toBe(3);
    expect(result.roots[0]).toMatchObject({
      accessIntent: "read_only",
      defaultBaseRef: "main",
      setupScript: script,
    });
    expect(result.roots.find((root) => root.id === result.primaryRootId)?.sourcePath).toBe(
      "/code/backend",
    );
    expect(buildRootsFromSelectedProjects([group, a])?.roots[0]?.setupScript).toBeUndefined();
  });

  it("rejects invalid selections instead of silently dropping repositories", () => {
    const projects = Array.from({ length: 17 }, (_, index) => project(`repo-${index}`));
    expect(buildRootsFromSelectedProjects(projects.slice(0, 16))?.roots).toHaveLength(16);
    expect(resolveDraftProjectSelection(projects, projects)).toBeNull();
    const a = project("a");
    for (const b of [
      { ...project("b"), environmentId: EnvironmentId.make("remote") },
      { ...project("b"), archivedAt: "2026-01-01" },
      { ...project("b"), isScratch: true },
    ]) {
      expect(resolveDraftProjectSelection([a, b], [a, b])).toBeNull();
    }
  });

  it("distinguishes path delimiters and ignores member order in draft identity", () => {
    const key = (paths: string[]) =>
      deriveAdhocGroupLogicalKey(
        environmentId,
        paths.map((sourcePath) => ({ sourcePath })),
        "/code/main",
      );
    expect(key(["/code/a,/code/b", "/code/c"])).not.toBe(key(["/code/a", "/code/b,/code/c"]));
    expect(key(["/code/a", "/code/b"])).toBe(key(["/code/b/", "/code/a/"]));
  });
});

import { describe, expect, it } from "vite-plus/test";
import { ProjectId, WorkspaceRootId } from "@t3tools/contracts";
import { workspaceCreateInput, workspaceCreationError } from "./createWorkspace";

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

describe("workspace creation", () => {
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
  });

  it.each([
    [{ ...input, title: "  " }, "Enter a workspace name."],
    [{ ...input, roots: [frontend] }, "Choose between 2 and 16 repositories."],
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

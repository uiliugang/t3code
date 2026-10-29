import { describe, expect, it } from "vite-plus/test";
import { ExecutionResourceId, WorkspaceRootId } from "@t3tools/contracts";
import { projectScriptTargets } from "./projectScripts.ts";

const frontend = WorkspaceRootId.make("frontend");
const backend = WorkspaceRootId.make("backend");
const nested = WorkspaceRootId.make("nested");
const a = ExecutionResourceId.make("a");
const b = ExecutionResourceId.make("b");
const workspace = {
  resources: [
    { id: a, checkoutRoot: "/wt/frontend", ownership: "managed" as const },
    { id: b, checkoutRoot: "/wt/backend", ownership: "borrowed" as const },
  ],
  bindings: [
    {
      rootId: frontend,
      resourceId: a,
      executionPath: "/wt/frontend",
      sourcePathAtBind: "/src/frontend",
    },
    {
      rootId: nested,
      resourceId: a,
      executionPath: "/wt/frontend/sub",
      sourcePathAtBind: "/src/frontend/sub",
    },
    {
      rootId: backend,
      resourceId: b,
      executionPath: "/wt/backend",
      sourcePathAtBind: "/src/backend",
    },
  ],
};

describe("project script repository scope", () => {
  it("defaults to all resources, deduplicates checkouts and never falls back for an empty or stale selection", () => {
    expect(projectScriptTargets({}, workspace).map((target) => target.cwd)).toEqual([
      "/wt/frontend",
      "/wt/backend",
    ]);
    expect(projectScriptTargets({ repositoryRootIds: [backend] }, workspace)).toMatchObject([
      { cwd: "/wt/backend", worktreePath: null, sourcePath: "/src/backend" },
    ]);
    expect(projectScriptTargets({ repositoryRootIds: [nested, frontend] }, workspace)).toHaveLength(
      1,
    );
    expect(projectScriptTargets({ repositoryRootIds: [nested] }, workspace)[0]?.cwd).toBe(
      "/wt/frontend/sub",
    );
    expect(projectScriptTargets({ repositoryRootIds: [] }, workspace)).toEqual([]);
    expect(
      projectScriptTargets({ repositoryRootIds: [WorkspaceRootId.make("deleted")] }, workspace),
    ).toEqual([]);
  });
});

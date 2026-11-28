import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  activeAndroidSidebarSpace,
  androidSidebarSpaceAnchor,
  androidSidebarSpaceDraftTargets,
  androidSidebarSpaceScope,
  availableAndroidSidebarProjects,
  type AndroidSidebarSpace,
  visibleAndroidWorkspaceThread,
} from "./android-sidebar-spaces";

function project(environment: string, id = "same-repo"): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environment),
    id: ProjectId.make(id),
    title: "Shared repository label",
    workspaceRoot: "/work/repo",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
  };
}

const A = project("mac");
const B = project("linux");
const A2 = project("mac", "second");
const ref = ({ id, environmentId }: EnvironmentProject) => ({ projectId: id, environmentId });
const space: AndroidSidebarSpace = { id: "work", name: "Work", projectRefs: [ref(A)] };
const noArchive = { archivedAt: null };

describe("Android workspace Spaces", () => {
  it("distinguishes All, explicit empty, and disconnected project membership", () => {
    expect(androidSidebarSpaceScope(null, [B])).toEqual({ kind: "all" });
    expect(androidSidebarSpaceScope({ ...space, projectRefs: [] }, [B])).toMatchObject({
      kind: "space",
      status: "empty",
      projectRefs: [],
    });
    expect(androidSidebarSpaceScope(space, [B])).toMatchObject({
      kind: "space",
      status: "unavailable",
      projectRefs: [],
    });
  });

  it("matches a real environment and project, not an identical project ID on another host", () => {
    expect(androidSidebarSpaceScope(space, [A, B])).toMatchObject({
      kind: "space",
      status: "ready",
      projectRefs: [ref(A)],
    });
    expect(androidSidebarSpaceDraftTargets(space, [A, B], () => true)).toEqual([A]);
  });

  it("has no default draft target for an empty, offline, or read-only Space", () => {
    expect(androidSidebarSpaceDraftTargets(space, [B], () => true)).toEqual([]);
    expect(androidSidebarSpaceDraftTargets(space, [A, B], () => false)).toEqual([]);
    expect(
      androidSidebarSpaceDraftTargets({ ...space, projectRefs: [] }, [A, B], () => true),
    ).toEqual([]);
  });

  it("supplies multiple writable member projects for an explicit chooser", () => {
    expect(
      androidSidebarSpaceDraftTargets(
        { ...space, projectRefs: [ref(A), ref(A2)] },
        [A, B, A2],
        () => true,
      ),
    ).toEqual([A, A2]);
  });

  it("restores an exact live anchor, not an archived, removed, or outside thread", () => {
    const lastThread = { environmentId: A.environmentId, threadId: ThreadId.make("last") };
    const saved = { ...space, lastThread };
    expect(
      androidSidebarSpaceAnchor(saved, [A, B], () => ({ projectId: A.id, ...noArchive })),
    ).toEqual(lastThread);
    expect(
      androidSidebarSpaceAnchor(saved, [A, B], () => ({ projectId: A2.id, ...noArchive })),
    ).toBeNull();
    expect(
      androidSidebarSpaceAnchor(saved, [B], () => ({ projectId: A.id, ...noArchive })),
    ).toBeNull();
    expect(
      androidSidebarSpaceAnchor(saved, [A, B], () => ({
        projectId: A.id,
        archivedAt: "2026-11-22",
      })),
    ).toBeNull();
    expect(androidSidebarSpaceAnchor(saved, [A, B], () => undefined)).toBeNull();
  });

  it("drops archived, scratch and missing environments without changing stored membership", () => {
    expect(
      availableAndroidSidebarProjects(
        [A, B, { ...A2, archivedAt: "2026-11-22" }, { ...A2, isScratch: true }],
        new Set([A.environmentId]),
      ),
    ).toEqual([A]);
    expect(activeAndroidSidebarSpace({ spaces: [space], selectedId: space.id })).toEqual(space);
    expect(activeAndroidSidebarSpace({ spaces: [space], selectedId: "removed" })).toBeNull();
  });
  it("does not record a draft or a thread beneath a utility route as the current anchor", () => {
    const home = { name: "Home" };
    const thread = { name: "Thread", params: { environmentId: "mac", threadId: "recent" } };
    expect(visibleAndroidWorkspaceThread({ index: 1, routes: [home, thread] })).toEqual(
      thread.params,
    );
    expect(
      visibleAndroidWorkspaceThread({ index: 2, routes: [home, thread, { name: "Settings" }] }),
    ).toBeNull();
    expect(
      visibleAndroidWorkspaceThread({
        index: 1,
        routes: [home, { name: "Thread", params: { draft: { requestId: "new" } } }],
      }),
    ).toBeNull();
  });
});

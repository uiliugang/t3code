import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  resolveSidebarSpaceScope,
  sidebarSpaceRgb,
  sidebarSpaceInitial,
  sidebarSpaceProjectKey,
  sidebarSpaceProjectsByEnvironment,
} from "./sidebarSpaces.ts";

const first = {
  environmentId: EnvironmentId.make("digital-lab"),
  projectId: ProjectId.make("api"),
};
const second = { environmentId: EnvironmentId.make("digital-home"), projectId: first.projectId };
const space = { id: "a", name: "A", projectRefs: [first, first] };

it("treats All, an empty Space and an unavailable Space independently", () => {
  expect(resolveSidebarSpaceScope(null, [second])).toEqual({ kind: "all" });
  expect(resolveSidebarSpaceScope({ ...space, projectRefs: [] }, [second])).toMatchObject({
    kind: "space",
    status: "empty",
    projectRefs: [],
  });
  expect(resolveSidebarSpaceScope(space, [second])).toMatchObject({
    kind: "space",
    status: "unavailable",
    projectRefs: [],
  });
  const recovered = resolveSidebarSpaceScope(space, [first, second]);
  expect(recovered).toMatchObject({ status: "ready", projectRefs: [first] });
  if (recovered.kind === "space")
    expect(sidebarSpaceProjectsByEnvironment(recovered)).toEqual(
      new Map([[first.environmentId, [first.projectId]]]),
    );
});

it("preserves pair identity when both ids contain delimiters", () => {
  expect(sidebarSpaceProjectKey({ environmentId: "a:b", projectId: "c" })).not.toEqual(
    sidebarSpaceProjectKey({ environmentId: "a", projectId: "b:c" }),
  );
});

it("keeps Space colour stable across renames and accepts Unicode initials", () => {
  const renamed = { ...space, name: "研发" };
  expect(sidebarSpaceRgb(renamed)).toBe(sidebarSpaceRgb(space));
  expect(sidebarSpaceRgb(space)).toMatch(/^\d+, \d+, \d+$/);
  expect(sidebarSpaceInitial("  研发")).toBe("研");
  expect(sidebarSpaceInitial("🔎 Search")).toBe("🔎");
});

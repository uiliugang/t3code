import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

export interface SidebarSpace {
  readonly id: string;
  readonly name: string;
  readonly projectRefs: readonly ScopedProjectRef[];
}

export type SidebarSpaceScope =
  | { readonly kind: "all" }
  | {
      readonly kind: "space";
      readonly id: string;
      readonly status: "empty" | "unavailable" | "ready";
      readonly projectRefs: readonly ScopedProjectRef[];
    };

export function sidebarSpaceProjectKey(ref: { environmentId: string; projectId: string }): string {
  return JSON.stringify([ref.environmentId, ref.projectId]);
}

export function normalizeSidebarSpaceName(name: string): string {
  return name.trim().normalize("NFKC").toLowerCase();
}

export function resolveSidebarSpaceScope(
  space: SidebarSpace | null,
  available: readonly ScopedProjectRef[],
): SidebarSpaceScope {
  if (space === null) return { kind: "all" };
  const keys = new Set(available.map(sidebarSpaceProjectKey));
  const refs = new Map<string, ScopedProjectRef>();
  for (const ref of space.projectRefs) {
    const key = sidebarSpaceProjectKey(ref);
    if (keys.has(key)) refs.set(key, ref);
  }
  return {
    kind: "space",
    id: space.id,
    status: space.projectRefs.length === 0 ? "empty" : refs.size === 0 ? "unavailable" : "ready",
    projectRefs: [...refs.values()],
  };
}

export function sidebarSpaceProjectsByEnvironment(
  scope: Extract<SidebarSpaceScope, { kind: "space" }>,
): Map<EnvironmentId, ProjectId[]> {
  const result = new Map<EnvironmentId, ProjectId[]>();
  for (const ref of scope.projectRefs) {
    const ids = result.get(ref.environmentId);
    if (ids) ids.push(ref.projectId);
    else result.set(ref.environmentId, [ref.projectId]);
  }
  return result;
}

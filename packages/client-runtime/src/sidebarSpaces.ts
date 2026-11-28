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

/** Ambient Space colours as `r, g, b` triplets, so CSS can add alpha with `rgba(var(--space-rgb), a)`. */
const SIDEBAR_SPACE_RGB = [
  "99, 126, 255",
  "16, 150, 110",
  "200, 120, 20",
  "224, 98, 130",
  "136, 100, 235",
  "32, 150, 190",
] as const;
const DEFAULT_SPACE_RGB = "138, 145, 160";

/** A Space keeps one colour everywhere without storing one: it follows the id, not the name. */
export function sidebarSpaceRgb(space: Pick<SidebarSpace, "id">): string {
  let hash = 0;
  for (let index = 0; index < space.id.length; index += 1)
    hash = (hash * 31 + space.id.charCodeAt(index)) >>> 0;
  return SIDEBAR_SPACE_RGB.at(hash % SIDEBAR_SPACE_RGB.length) ?? DEFAULT_SPACE_RGB;
}

export function sidebarSpaceInitial(name: string): string {
  return Array.from(name.trim())[0] ?? "#";
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

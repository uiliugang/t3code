import {
  ProjectId,
  WorkspaceRootId,
  type EnvironmentId,
  type ProjectScript,
  type ProjectWorkspaceConfig,
  type ProjectWorkspaceRoot,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import type { CreateProjectInput } from "@t3tools/client-runtime/state/projects";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { projectScriptAppliesToRoots } from "@t3tools/shared/projectScripts";
import { translateUi, type UiTranslator } from "@t3tools/shared/uiLocale";

const MAX_GROUP_REPOSITORIES = 16;
const MAX_GROUP_TITLE_LENGTH = 200;
const MAX_ROOT_ALIAS_LENGTH = 80;

export interface GroupableProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly workspaceConfig?: ProjectWorkspaceConfig | undefined;
  readonly scripts?: readonly ProjectScript[] | undefined;
  readonly archivedAt?: string | null | undefined;
  readonly isScratch?: boolean | undefined;
}

export function workspaceCreationError(
  input: {
    title: string;
    roots: readonly ProjectWorkspaceRoot[];
    primaryRootId: WorkspaceRootId;
  },
  t: UiTranslator = translateUi.bind(null, "en"),
): string | null {
  if (!input.title.trim()) return t("Enter a group name.");
  if (input.roots.length < 1 || input.roots.length > MAX_GROUP_REPOSITORIES)
    return t("Choose between 1 and 16 repositories.");
  if (input.roots.some((root) => !root.alias.trim() || !root.sourcePath.trim()))
    return t("Enter a name and directory for every repository.");
  if (new Set(input.roots.map((root) => root.alias.trim())).size !== input.roots.length)
    return t("Repository names must be unique.");
  if (
    new Set(input.roots.map((root) => normalizeProjectPathForComparison(root.sourcePath))).size !==
    input.roots.length
  )
    return t("Choose each repository directory only once.");
  if (!input.roots.some((root) => root.id === input.primaryRootId))
    return t("Choose a primary repository.");
  return null;
}

export function workspaceCreateInput(input: {
  projectId: ProjectId;
  title: string;
  roots: readonly ProjectWorkspaceRoot[];
  primaryRootId: WorkspaceRootId;
}): CreateProjectInput {
  const error = workspaceCreationError(input);
  if (error) throw new Error(error);
  const roots = input.roots.map((root) => ({
    ...root,
    alias: root.alias.trim(),
    sourcePath: root.sourcePath.trim(),
    description: root.description.trim(),
    defaultSelected: true,
  }));
  return {
    projectId: input.projectId,
    title: input.title.trim(),
    workspaceRoot: roots.find((root) => root.id === input.primaryRootId)!.sourcePath,
    workspaceConfig: { primaryRootId: input.primaryRootId, roots },
    createWorkspaceRootIfMissing: false,
    defaultModelSelection: null,
  };
}

function clampText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength).trimEnd();
}

function parentFolderSegment(sourcePath: string): string | null {
  const trimmed = sourcePath.trim().replace(/[\\/]+$/u, "");
  const parts = trimmed.split(/[\\/]+/u).filter(Boolean);
  return parts.length >= 2 ? (parts.at(-2) ?? null) : null;
}

function uniqueAlias(baseAlias: string, sourcePath: string, used: Set<string>): string {
  const cleanBase = clampText(baseAlias.trim() || "repo", MAX_ROOT_ALIAS_LENGTH);
  if (!used.has(cleanBase)) {
    used.add(cleanBase);
    return cleanBase;
  }
  const parent = parentFolderSegment(sourcePath);
  if (parent) {
    const withParent = clampText(`${parent}-${cleanBase}`, MAX_ROOT_ALIAS_LENGTH);
    if (!used.has(withParent)) {
      used.add(withParent);
      return withParent;
    }
  }
  let suffix = 2;
  while (true) {
    const suffixText = `-${suffix}`;
    const candidate = `${clampText(cleanBase, MAX_ROOT_ALIAS_LENGTH - suffixText.length)}${suffixText}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    suffix += 1;
  }
}

export interface FlattenedProjectRoots {
  readonly roots: readonly ProjectWorkspaceRoot[];
  readonly primaryRootId: WorkspaceRootId;
}

export function buildRootsFromSelectedProjects(
  selectedProjects: readonly GroupableProject[],
  options?: {
    readonly includeSetupScripts?: boolean;
    readonly makeRootId?: (index: number) => WorkspaceRootId;
  },
): FlattenedProjectRoots | null {
  if (
    selectedProjects.length === 0 ||
    selectedProjects.some(
      (project) =>
        project.isScratch ||
        project.archivedAt != null ||
        project.environmentId !== selectedProjects[0]!.environmentId,
    )
  )
    return null;
  const includeSetupScripts = options?.includeSetupScripts ?? false;
  const makeRootId =
    options?.makeRootId ?? ((index: number) => WorkspaceRootId.make(`root-${index + 1}`));
  const rootIndexByPath = new Map<string, number>();
  const usedAliases = new Set<string>();
  const roots: ProjectWorkspaceRoot[] = [];
  let primaryRootId: WorkspaceRootId | null = null;

  for (const project of selectedProjects) {
    const projectSetupScript = includeSetupScripts
      ? project.scripts?.find((script) => script.runOnWorktreeCreate)
      : undefined;
    const sourceRoots =
      project.workspaceConfig?.roots.filter((root) => root.defaultSelected) ??
      ([
        {
          id: makeRootId(roots.length),
          alias: project.title,
          sourcePath: project.workspaceRoot,
          description: "",
          defaultSelected: true,
          accessIntent: "write" as const,
          ...(projectSetupScript ? { setupScript: projectSetupScript } : {}),
        },
      ] satisfies readonly ProjectWorkspaceRoot[]);
    const preferredPrimarySourcePath = project.workspaceConfig
      ? project.workspaceConfig.roots.find(
          (root) => root.id === project.workspaceConfig?.primaryRootId,
        )?.sourcePath
      : project.workspaceRoot;

    for (const candidate of sourceRoots) {
      const normalizedPath = normalizeProjectPathForComparison(candidate.sourcePath);
      if (!normalizedPath) continue;
      const existingIndex = rootIndexByPath.get(normalizedPath);
      if (existingIndex !== undefined) {
        const existing = roots[existingIndex]!;
        if (candidate.accessIntent === "read_only") {
          roots[existingIndex] = { ...existing, accessIntent: "read_only" };
        }
        if (
          primaryRootId === null &&
          preferredPrimarySourcePath &&
          normalizeProjectPathForComparison(preferredPrimarySourcePath) === normalizedPath
        ) {
          primaryRootId = existing.id;
        }
        continue;
      }
      if (roots.length >= MAX_GROUP_REPOSITORIES) return null;
      rootIndexByPath.set(normalizedPath, roots.length);
      const id = makeRootId(roots.length);
      const alias = uniqueAlias(
        candidate.alias || project.title,
        candidate.sourcePath,
        usedAliases,
      );
      const setupScript =
        includeSetupScripts &&
        candidate.setupScript &&
        projectScriptAppliesToRoots(candidate.setupScript, [candidate.id])
          ? {
              ...candidate.setupScript,
              ...(candidate.setupScript.repositoryRootIds ? { repositoryRootIds: [id] } : {}),
            }
          : undefined;
      roots.push({
        id,
        alias,
        sourcePath: candidate.sourcePath.trim(),
        description: candidate.description.trim(),
        defaultSelected: true,
        accessIntent: candidate.accessIntent,
        ...(candidate.defaultBaseRef ? { defaultBaseRef: candidate.defaultBaseRef } : {}),
        ...(setupScript ? { setupScript } : {}),
      });
      if (
        primaryRootId === null &&
        preferredPrimarySourcePath &&
        normalizeProjectPathForComparison(preferredPrimarySourcePath) === normalizedPath
      ) {
        primaryRootId = id;
      }
    }
  }

  if (roots.length === 0) return null;
  return {
    roots,
    primaryRootId: primaryRootId ?? roots[0]!.id,
  };
}

function deriveAutoGroupTitle(roots: readonly Pick<ProjectWorkspaceRoot, "alias">[]): string {
  if (roots.length === 0) return "";
  if (roots.length === 1) return clampText(roots[0]!.alias.trim(), MAX_GROUP_TITLE_LENGTH);
  if (roots.length === 2) {
    return clampText(
      `${roots[0]!.alias.trim()} + ${roots[1]!.alias.trim()}`,
      MAX_GROUP_TITLE_LENGTH,
    );
  }
  const suffix = ` +${roots.length - 2}`;
  const head = clampText(
    `${roots[0]!.alias.trim()} + ${roots[1]!.alias.trim()}`,
    MAX_GROUP_TITLE_LENGTH - suffix.length,
  );
  return `${head}${suffix}`;
}

export function deriveAdhocGroupLogicalKey(
  environmentId: EnvironmentId,
  roots: readonly Pick<ProjectWorkspaceRoot, "sourcePath">[],
  primarySourcePath: string,
): string {
  const normalizedPrimary = normalizeProjectPathForComparison(primarySourcePath);
  const sortedPaths = roots
    .map((root) => normalizeProjectPathForComparison(root.sourcePath))
    .toSorted();
  return `${environmentId}:adhoc-group:${JSON.stringify([normalizedPrimary, sortedPaths])}`;
}

function findMatchingGroupProject<T extends GroupableProject>(
  projects: readonly T[],
  environmentId: EnvironmentId,
  flattened: FlattenedProjectRoots,
): T | null {
  const targetRoots = new Map(
    flattened.roots.map((root) => [normalizeProjectPathForComparison(root.sourcePath), root]),
  );
  const primaryRoot = flattened.roots.find((root) => root.id === flattened.primaryRootId);
  if (!primaryRoot) return null;
  const targetPrimaryPath = normalizeProjectPathForComparison(primaryRoot.sourcePath);

  for (const project of projects) {
    if (
      project.environmentId !== environmentId ||
      project.archivedAt != null ||
      project.isScratch ||
      !project.workspaceConfig
    ) {
      continue;
    }
    const projectSelectedRoots = project.workspaceConfig.roots.filter(
      (root) => root.defaultSelected,
    );
    if (projectSelectedRoots.length !== targetRoots.size) continue;
    const projectPrimary = project.workspaceConfig.roots.find(
      (root) => root.id === project.workspaceConfig?.primaryRootId,
    );
    if (
      !projectPrimary ||
      normalizeProjectPathForComparison(projectPrimary.sourcePath) !== targetPrimaryPath
    ) {
      continue;
    }
    const allMatch = projectSelectedRoots.every((root) => {
      const target = targetRoots.get(normalizeProjectPathForComparison(root.sourcePath));
      return (
        target !== undefined &&
        target.accessIntent === root.accessIntent &&
        (target.defaultBaseRef ?? "HEAD") === (root.defaultBaseRef ?? "HEAD")
      );
    });
    if (allMatch) return project;
  }
  return null;
}

export type ResolvedDraftProjectSelection<T extends GroupableProject> =
  | {
      readonly kind: "single";
      readonly project: T;
      readonly projectRef: ScopedProjectRef;
    }
  | {
      readonly kind: "existing-group";
      readonly project: T;
      readonly projectRef: ScopedProjectRef;
    }
  | {
      readonly kind: "adhoc-group";
      readonly primaryProject: T;
      readonly primaryProjectRef: ScopedProjectRef;
      readonly selectedProjectIds: readonly ProjectId[];
      readonly flattened: FlattenedProjectRoots;
      readonly title: string;
      readonly logicalProjectKey: string;
    };

export function resolveDraftProjectSelection<T extends GroupableProject>(
  selectedProjects: readonly T[],
  allProjectsInEnvironment: readonly T[],
  options?: {
    readonly includeSetupScripts?: boolean;
    readonly makeRootId?: (index: number) => WorkspaceRootId;
  },
): ResolvedDraftProjectSelection<T> | null {
  const flattened = buildRootsFromSelectedProjects(selectedProjects, options);
  if (!flattened) return null;
  const primaryProject = selectedProjects[0]!;
  if (selectedProjects.length === 1) {
    return {
      kind: "single",
      project: primaryProject,
      projectRef: {
        environmentId: primaryProject.environmentId,
        projectId: primaryProject.id,
      },
    };
  }
  if (
    flattened.roots.length === 1 &&
    selectedProjects.every((project) => project.workspaceConfig === undefined)
  ) {
    return {
      kind: "single",
      project: primaryProject,
      projectRef: {
        environmentId: primaryProject.environmentId,
        projectId: primaryProject.id,
      },
    };
  }
  const existingGroup = findMatchingGroupProject(
    allProjectsInEnvironment,
    primaryProject.environmentId,
    flattened,
  );
  if (existingGroup) {
    return {
      kind: "existing-group",
      project: existingGroup,
      projectRef: {
        environmentId: existingGroup.environmentId,
        projectId: existingGroup.id,
      },
    };
  }
  const primaryRoot =
    flattened.roots.find((root) => root.id === flattened.primaryRootId) ?? flattened.roots[0]!;
  return {
    kind: "adhoc-group",
    primaryProject,
    primaryProjectRef: {
      environmentId: primaryProject.environmentId,
      projectId: primaryProject.id,
    },
    selectedProjectIds: selectedProjects.map((project) => project.id),
    flattened,
    title: deriveAutoGroupTitle(flattened.roots),
    logicalProjectKey: deriveAdhocGroupLogicalKey(
      primaryProject.environmentId,
      flattened.roots,
      primaryRoot.sourcePath,
    ),
  };
}

import type { ProjectId, ProjectWorkspaceRoot, WorkspaceRootId } from "@t3tools/contracts";
import type { CreateProjectInput } from "@t3tools/client-runtime/state/projects";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { translateUi, type UiTranslator } from "@t3tools/shared/uiLocale";

export function workspaceCreationError(
  input: {
    title: string;
    roots: readonly ProjectWorkspaceRoot[];
    primaryRootId: WorkspaceRootId;
  },
  t: UiTranslator = translateUi.bind(null, "en"),
): string | null {
  if (!input.title.trim()) return t("Enter a group name.");
  if (input.roots.length < 1 || input.roots.length > 16)
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

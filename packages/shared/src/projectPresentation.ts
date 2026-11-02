import type { ProjectWorkspaceConfig } from "@t3tools/contracts";

export function projectDisplayKind(project: {
  readonly workspaceConfig?: ProjectWorkspaceConfig | undefined;
}) {
  return project.workspaceConfig ? "group" : "repo";
}

export function formatProjectDisplayName(name: string, capitalize: boolean) {
  return capitalize ? name.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase()) : name;
}

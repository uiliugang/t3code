import type { ProjectId, ServerSettings } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

export function worktreeDependencyEnvironment(settings: ServerSettings, projectId: ProjectId) {
  return {
    PNPM_CONFIG_VIRTUAL_STORE_TYPE: resolveProjectSettings(settings, projectId).settings
      .worktreeSharedDependencies
      ? "global"
      : "project",
  };
}

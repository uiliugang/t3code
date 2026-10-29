import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ProjectId, TrimmedNonEmptyString, WorkspaceRootId } from "./baseSchemas.ts";
import { ProjectWorkspaceRoot } from "./project.ts";
import { ProjectSettingsOverrides } from "./settings.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const RelativeRepositoryDirectory = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (!value.startsWith("/") &&
        !value.includes("\\") &&
        !value.includes(":") &&
        !value.split("/").includes("..")) ||
      "Use a repository-relative directory.",
  ),
);

export const ProjectTransferWorkspace = Schema.Struct({
  grouped: Schema.optionalKey(Schema.Boolean),
  primaryRootId: WorkspaceRootId,
  roots: Schema.Array(
    Schema.Struct({
      ...Struct.omit(ProjectWorkspaceRoot.fields, ["sourcePath"]),
      remoteUrl: Schema.NullOr(TrimmedNonEmptyString),
      directory: RelativeRepositoryDirectory,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
}).check(
  Schema.makeFilter(
    (workspace) =>
      ((workspace.grouped !== false || workspace.roots.length === 1) &&
        new Set(workspace.roots.map((root) => root.id)).size === workspace.roots.length &&
        new Set(workspace.roots.map((root) => root.alias)).size === workspace.roots.length &&
        workspace.roots.some(
          (root) => root.id === workspace.primaryRootId && root.defaultSelected,
        )) ||
      "Workspace roots must have unique IDs and aliases, and a selected primary root.",
  ),
);
export type ProjectTransferWorkspace = typeof ProjectTransferWorkspace.Type;

export const ProjectImportDefinition = Schema.Struct({
  name: TrimmedNonEmptyString,
  settings: Schema.toType(ProjectSettingsOverrides),
  providers: Schema.Record(ProviderInstanceId, ProviderDriverKind),
  workspace: ProjectTransferWorkspace,
}).check(
  Schema.makeFilter(
    (project) =>
      [
        ...(project.settings.defaultProjectScripts ?? []),
        ...project.workspace.roots.flatMap((root) => (root.setupScript ? [root.setupScript] : [])),
      ].every((script) =>
        (script.repositoryRootIds ?? []).every((id) =>
          project.workspace.roots.some((root) => root.id === id),
        ),
      ) || "Action repository references must belong to this workspace.",
  ),
);
export type ProjectImportDefinition = typeof ProjectImportDefinition.Type;

export const ProjectConfigurationExportInput = Schema.Struct({
  projectIds: Schema.optionalKey(Schema.Array(ProjectId).check(Schema.isMaxLength(1000))),
});
export const ProjectConfigurationExportResult = Schema.Array(
  Schema.Struct({
    projectId: ProjectId,
    configuration: ProjectImportDefinition,
  }),
);

export const ProjectImportStartInput = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  destinationDirectory: Schema.optionalKey(TrimmedNonEmptyString),
  projects: Schema.Array(ProjectImportDefinition).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1000),
  ),
});
export type ProjectImportStartInput = typeof ProjectImportStartInput.Type;
export const ProjectImportActionInput = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});

export const ProjectImportFailure = Schema.Literals([
  "clone_failed",
  "authentication_failed",
  "host_key_unverified",
  "destination_conflict",
  "missing_remote",
  "project_failed",
  "settings_failed",
  "interrupted",
  "filesystem_failed",
]);
export const ProjectImportRepositoryState = Schema.Struct({
  key: TrimmedNonEmptyString,
  remoteUrl: Schema.NullOr(TrimmedNonEmptyString),
  destinationPath: TrimmedNonEmptyString,
  phase: Schema.Literals(["pending", "running", "ready", "failed"]),
  failure: Schema.NullOr(ProjectImportFailure),
  stagingPath: Schema.NullOr(TrimmedNonEmptyString),
  cloned: Schema.Boolean,
});
export const ProjectImportProjectState = Schema.Struct({
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  phase: Schema.Literals(["pending", "ready", "failed"]),
  failure: Schema.NullOr(ProjectImportFailure),
});
export const ProjectImportSnapshot = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  destinationDirectory: TrimmedNonEmptyString,
  phase: Schema.Literals(["running", "paused", "partial", "done"]),
  repositories: Schema.Array(ProjectImportRepositoryState),
  projects: Schema.Array(ProjectImportProjectState),
});
export type ProjectImportSnapshot = typeof ProjectImportSnapshot.Type;

export class ProjectImportError extends Schema.TaggedError<ProjectImportError>()(
  "ProjectImportError",
  {
    operation: Schema.Literals(["export", "read", "save", "start", "retry", "forget"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return typeof this.cause === "string"
      ? this.cause
      : `Project configuration ${this.operation} failed. Saved import information is retained for retry.`;
  }
}

export function projectImportFailureMessage(failure: typeof ProjectImportFailure.Type): string {
  switch (failure) {
    case "authentication_failed":
      return "Git authentication failed. Fix credentials on this environment, then retry.";
    case "host_key_unverified":
      return "The SSH host key is not trusted. Verify it on this environment, then retry.";
    case "clone_failed":
      return "Clone failed. Check network access and repository permissions, then retry.";
    case "filesystem_failed":
      return "The clone could not be saved. Check directory permissions and disk space, then retry.";
    case "destination_conflict":
      return "The destination contains another repository or other files. No files were replaced.";
    case "missing_remote":
      return "This repository has no usable clone URL. Its known configuration has been retained.";
    case "project_failed":
      return "The checkout could not be registered as a project. Its repository and configuration are retained.";
    case "settings_failed":
      return "Project settings could not be applied. Configure the required providers, then retry.";
    case "interrupted":
      return "Import was interrupted. Retry to continue from the saved progress.";
  }
}

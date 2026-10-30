import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PROJECT_FOLDER_BATCH_LIMIT = 50;
const FolderPath = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));

export const ProjectFoldersInspectInput = Schema.Struct({
  paths: Schema.Array(FolderPath).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PROJECT_FOLDER_BATCH_LIMIT),
  ),
});
export type ProjectFoldersInspectInput = typeof ProjectFoldersInspectInput.Type;

export const ProjectFolderCandidate = Schema.Struct({
  path: FolderPath,
  workspaceRoot: Schema.NullOr(FolderPath),
  title: Schema.String,
  repositoryKey: Schema.NullOr(Schema.String),
  existingProjectId: Schema.NullOr(ProjectId),
  matchingRepositoryProjectId: Schema.NullOr(ProjectId),
  error: Schema.NullOr(Schema.String),
});
export type ProjectFolderCandidate = typeof ProjectFolderCandidate.Type;
export const ProjectFoldersInspectResult = Schema.Array(ProjectFolderCandidate);

export const ProjectFoldersImportInput = Schema.Struct({
  folders: Schema.Array(
    Schema.Struct({
      path: FolderPath,
      allowSameRepository: Schema.Boolean,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(PROJECT_FOLDER_BATCH_LIMIT)),
});
export type ProjectFoldersImportInput = typeof ProjectFoldersImportInput.Type;

export const ProjectFolderImportResult = Schema.Struct({
  path: FolderPath,
  status: Schema.Literals(["created", "existing", "repository", "failed"]),
  projectId: Schema.NullOr(ProjectId),
  error: Schema.NullOr(Schema.String),
});
export type ProjectFolderImportResult = typeof ProjectFolderImportResult.Type;
export const ProjectFoldersImportResult = Schema.Array(ProjectFolderImportResult);

export class ProjectFoldersError extends Schema.TaggedError<ProjectFoldersError>()(
  "ProjectFoldersError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not inspect or import project folders.";
  }
}

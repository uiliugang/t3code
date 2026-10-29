import * as Schema from "effect/Schema";
import {
  ExecutionResourceId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RepositoryStoreId,
  ThreadId,
  TrimmedNonEmptyString,
  WorkspaceRevisionId,
  WorkspaceRootId,
} from "./baseSchemas.ts";
import { ProjectWorkspaceRoot } from "./project.ts";

export const WorkspaceCheckoutIdentity = Schema.Struct({
  checkoutRoot: TrimmedNonEmptyString,
  gitDir: TrimmedNonEmptyString,
  commonDir: TrimmedNonEmptyString,
  gitDirIdentity: TrimmedNonEmptyString,
  commonDirIdentity: TrimmedNonEmptyString,
});
export type WorkspaceCheckoutIdentity = typeof WorkspaceCheckoutIdentity.Type;

export const WorkspaceExecutionResource = Schema.Struct({
  id: ExecutionResourceId,
  storeId: RepositoryStoreId,
  name: TrimmedNonEmptyString,
  checkoutRoot: TrimmedNonEmptyString,
  identity: WorkspaceCheckoutIdentity,
  ownership: Schema.Literals(["borrowed", "managed"]),
  generation: PositiveInt,
});
export type WorkspaceExecutionResource = typeof WorkspaceExecutionResource.Type;

export const WorkspaceRootBinding = Schema.Struct({
  rootId: WorkspaceRootId,
  alias: ProjectWorkspaceRoot.fields.alias,
  description: ProjectWorkspaceRoot.fields.description,
  accessIntent: ProjectWorkspaceRoot.fields.accessIntent,
  resourceId: ExecutionResourceId,
  relativeSubpath: Schema.String,
  sourcePathAtBind: TrimmedNonEmptyString,
  executionPath: TrimmedNonEmptyString,
  launchBaseRef: Schema.NullOr(TrimmedNonEmptyString),
  launchBaseCommit: Schema.NullOr(TrimmedNonEmptyString),
  launchBranch: Schema.NullOr(TrimmedNonEmptyString),
});
export type WorkspaceRootBinding = typeof WorkspaceRootBinding.Type;

export const ThreadWorkspaceRevision = Schema.Struct({
  id: WorkspaceRevisionId,
  projectId: ProjectId,
  sourceProjectVersion: NonNegativeInt,
  previousRevisionId: Schema.NullOr(WorkspaceRevisionId),
  primaryRootId: WorkspaceRootId,
  mode: Schema.Literals(["existing", "isolated"]),
  resources: Schema.Array(WorkspaceExecutionResource).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
  bindings: Schema.Array(WorkspaceRootBinding).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  createdAt: IsoDateTime,
}).check(
  Schema.makeFilter((revision) => {
    const resourceIds = new Set(revision.resources.map((resource) => resource.id));
    const rootIds = new Set(revision.bindings.map((binding) => binding.rootId));
    return (
      (resourceIds.size === revision.resources.length &&
        rootIds.size === revision.bindings.length &&
        rootIds.has(revision.primaryRootId) &&
        revision.bindings.every((binding) => resourceIds.has(binding.resourceId)) &&
        revision.resources.every((resource) =>
          revision.bindings.some((binding) => binding.resourceId === resource.id),
        )) ||
      "Workspace bindings must uniquely identify roots and reference exactly the prepared resources."
    );
  }),
);
export type ThreadWorkspaceRevision = typeof ThreadWorkspaceRevision.Type;

export const ThreadRepositoryTarget = Schema.Struct({
  threadId: ThreadId,
  workspaceRevisionId: WorkspaceRevisionId,
  resourceId: ExecutionResourceId,
});
export type ThreadRepositoryTarget = typeof ThreadRepositoryTarget.Type;

export const WorkspaceCheckoutInput = Schema.Struct({
  threadId: ThreadId,
  cwd: TrimmedNonEmptyString,
  expectedWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
  expectedWorkspaceRevisionId: Schema.NullOr(WorkspaceRevisionId),
  resourceId: Schema.optional(ExecutionResourceId),
});
export type WorkspaceCheckoutInput = typeof WorkspaceCheckoutInput.Type;

export const WorkspaceCheckoutResult = Schema.Struct({
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
});
export type WorkspaceCheckoutResult = typeof WorkspaceCheckoutResult.Type;

export class WorkspaceCheckoutError extends Schema.TaggedError<WorkspaceCheckoutError>()(
  "WorkspaceCheckoutError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return this.detail;
  }
}

export const WorkspaceRecoveryInput = Schema.Struct({
  threadId: ThreadId,
  expectedRevisionId: Schema.NullOr(WorkspaceRevisionId),
  action: Schema.Literals(["inspect", "retry-setup", "accept-current-files"]),
});
export type WorkspaceRecoveryInput = typeof WorkspaceRecoveryInput.Type;

export const WorkspaceRecoveryResult = Schema.Struct({
  kind: Schema.Literals(["ready", "preparation", "restore"]),
  detail: Schema.String,
  repositories: Schema.Array(
    Schema.Struct({ name: Schema.String, path: Schema.String, stage: Schema.String }),
  ),
});
export type WorkspaceRecoveryResult = typeof WorkspaceRecoveryResult.Type;

export class WorkspaceRecoveryError extends Schema.TaggedError<WorkspaceRecoveryError>()(
  "WorkspaceRecoveryError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return this.detail;
  }
}

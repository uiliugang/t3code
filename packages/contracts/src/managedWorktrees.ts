import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ManagedWorktreeTarget = Schema.Struct({
  id: TrimmedNonEmptyString,
  fingerprint: TrimmedNonEmptyString,
});
export const ManagedWorktreeGroup = Schema.Struct({
  ...ManagedWorktreeTarget.fields,
  projectId: ProjectId,
  projectTitle: Schema.String,
  title: Schema.String,
  threads: Schema.Array(Schema.Struct({ id: ThreadId, title: Schema.String })),
  resources: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      name: Schema.String,
      branch: Schema.NullOr(Schema.String),
      present: Schema.Boolean,
      ignoredFiles: Schema.Boolean,
    }),
  ),
  status: Schema.Literals(["ready", "blocked", "removed", "partial", "failed"]),
  recoveryPending: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
});
export type ManagedWorktreeGroup = typeof ManagedWorktreeGroup.Type;

export const ManagedWorktreesListInput = Schema.Struct({
  projectIds: Schema.optional(Schema.Array(ProjectId)),
});
export type ManagedWorktreesListInput = typeof ManagedWorktreesListInput.Type;
export const ManagedWorktreesRemoveInput = Schema.Struct({
  targets: Schema.Array(ManagedWorktreeTarget).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
  deleteIgnoredFiles: Schema.Boolean,
});
export type ManagedWorktreesRemoveInput = typeof ManagedWorktreesRemoveInput.Type;
export const ManagedWorktreesRestoreInput = Schema.Struct({ threadId: ThreadId });
export type ManagedWorktreesRestoreInput = typeof ManagedWorktreesRestoreInput.Type;
export const ManagedWorktreeResult = Schema.Struct({
  id: Schema.String,
  outcome: Schema.Literals(["removed", "skipped", "failed"]),
  detail: Schema.String,
});
export type ManagedWorktreeResult = typeof ManagedWorktreeResult.Type;
export class ManagedWorktreeError extends Schema.TaggedError<ManagedWorktreeError>()(
  "ManagedWorktreeError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return this.detail;
  }
}

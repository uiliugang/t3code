import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export const RequirementFilters = Schema.Struct({
  environmentId: Schema.NullOr(EnvironmentId),
  projectId: Schema.NullOr(ProjectId),
  source: Schema.Literals(["all", "local", "github", "gitlab", "linear", "meituan"]),
  query: Schema.String,
  assignee: Schema.String,
  archived: Schema.Boolean,
  labels: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))).check(
    Schema.isMaxLength(20),
  ),
});
export type RequirementFilters = typeof RequirementFilters.Type;
export function requirementViewsMatch(left: RequirementFilters, right: RequirementFilters) {
  return (
    left.environmentId === right.environmentId &&
    left.projectId === right.projectId &&
    left.source === right.source &&
    left.query === right.query &&
    left.assignee === right.assignee &&
    left.archived === right.archived &&
    left.labels.length === right.labels.length &&
    left.labels.every((label) => right.labels.includes(label))
  );
}

export const SAVED_VIEW_NAME_MAX_LENGTH = 80;

export const SavedViewIdentity = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(SAVED_VIEW_NAME_MAX_LENGTH)),
});

export function savedViewNameError(
  name: string,
  views: ReadonlyArray<typeof SavedViewIdentity.Type>,
  editingId?: string,
  resolve: MFunctionType = mFallback,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return resolve(msg("Enter a name for this view."));
  if (trimmed.length > SAVED_VIEW_NAME_MAX_LENGTH) {
    return resolve(msg("Use {max} characters or fewer.", { max: SAVED_VIEW_NAME_MAX_LENGTH }));
  }
  return views.some(
    (view) => view.id !== editingId && view.name.toLowerCase() === trimmed.toLowerCase(),
  )
    ? resolve(msg("A view with this name already exists."))
    : null;
}

import * as Schema from "effect/Schema";

import {
  CommandId,
  CheckpointId,
  CheckpointRef,
  IsoDateTime,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const WorkItemId = TrimmedNonEmptyString.pipe(Schema.brand("WorkItemId"));
export type WorkItemId = typeof WorkItemId.Type;
export const WorkItemExecutionId = TrimmedNonEmptyString.pipe(Schema.brand("WorkItemExecutionId"));
export type WorkItemExecutionId = typeof WorkItemExecutionId.Type;
export const WorkItemStatus = Schema.Literals(["todo", "in_progress", "in_review", "done"]);
export type WorkItemStatus = typeof WorkItemStatus.Type;
export const WorkItemPriority = Schema.Literals(["P0", "P1", "P2", "P3"]);
export type WorkItemPriority = typeof WorkItemPriority.Type;
const Text = Schema.String.check(Schema.isMaxLength(16_000));
const Lines = Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(
  Schema.isMaxLength(32),
);
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const WorkItemSource = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String.check(Schema.isMaxLength(300)),
  messageId: Schema.optional(Schema.String),
});
export type WorkItemSource = typeof WorkItemSource.Type;
export const WorkItemSpecification = Schema.Struct({
  description: Text,
  constraints: Lines,
  acceptanceCriteria: Lines,
});
export type WorkItemSpecification = typeof WorkItemSpecification.Type;
export const WorkItemExecution = Schema.Struct({
  id: WorkItemExecutionId,
  workItemId: WorkItemId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  assignment: Text,
  prompt: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  specRevision: Revision,
  specSnapshot: WorkItemSpecification,
  status: Schema.Literals([
    "queued",
    "preparing",
    "running",
    "waiting",
    "stopping",
    "completed",
    "failed",
    "cancelled",
    "recovering",
  ]),
  summary: Text,
  artifacts: Lines,
  submitted: Schema.Boolean,
  stopRequested: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  resolvedWorkspacePath: Schema.optional(Schema.NullOr(Schema.String)),
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  checkpointId: Schema.optional(Schema.NullOr(CheckpointId)),
  checkpointRef: Schema.optional(Schema.NullOr(CheckpointRef)),
  codeEvidenceCapturedAt: Schema.optional(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkItemExecution = typeof WorkItemExecution.Type;
export const WorkItemExecutionEvidence = Schema.Struct({
  executionId: WorkItemExecutionId,
  threadId: ThreadId,
  specRevision: Revision,
  workspacePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  checkpointId: Schema.NullOr(CheckpointId),
  checkpointRef: Schema.NullOr(CheckpointRef),
  capturedAt: IsoDateTime,
});
export const WorkItemSubmission = Schema.Struct({
  specRevision: Revision,
  executionIds: Schema.Array(WorkItemExecutionId),
  summary: Text,
  artifacts: Lines,
  executionEvidence: Schema.optional(Schema.Array(WorkItemExecutionEvidence)),
  createdAt: IsoDateTime,
});
export type WorkItemSubmission = typeof WorkItemSubmission.Type;
export const WorkItem = Schema.Struct({
  id: WorkItemId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  ...WorkItemSpecification.fields,
  specRevision: Revision,
  version: Revision,
  status: WorkItemStatus,
  priority: WorkItemPriority,
  archived: Schema.Boolean,
  sources: Schema.Array(WorkItemSource).check(Schema.isMaxLength(32)),
  executions: Schema.Array(WorkItemExecution),
  submission: Schema.NullOr(WorkItemSubmission),
  acceptedAt: Schema.NullOr(IsoDateTime),
  reviewFeedback: Schema.optional(Text),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkItem = typeof WorkItem.Type;
export const WorkItemCandidate = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  description: Text,
  status: Schema.String,
  updatedAt: IsoDateTime,
});
export type WorkItemCandidate = typeof WorkItemCandidate.Type;
export const WorkItemCursor = Schema.Struct({ updatedAt: IsoDateTime, id: WorkItemId });
export const WorkItemListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  id: Schema.optional(WorkItemId),
  cursor: Schema.optional(WorkItemCursor),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type WorkItemListInput = typeof WorkItemListInput.Type;
export const WorkItemSummary = Schema.Struct({
  id: WorkItemId,
  projectId: ProjectId,
  title: WorkItem.fields.title,
  description: Schema.String.check(Schema.isMaxLength(500)),
  specRevision: Revision,
  version: Revision,
  status: WorkItemStatus,
  priority: WorkItemPriority,
  archived: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  executionCount: Schema.Int,
  activeExecutionCount: Schema.Int,
});
export type WorkItemSummary = typeof WorkItemSummary.Type;
export const WorkItemListResult = Schema.Struct({
  items: Schema.Array(WorkItemSummary),
  item: Schema.optional(WorkItem),
  candidates: Schema.Array(WorkItemCandidate),
  nextCursor: Schema.optional(Schema.NullOr(WorkItemCursor)),
});
export type WorkItemListResult = typeof WorkItemListResult.Type;
const Command = { commandId: CommandId };
const Existing = { ...Command, id: WorkItemId };
export const WorkItemParticipant = Schema.Struct({
  assignment: Text,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
});
export type WorkItemParticipant = typeof WorkItemParticipant.Type;
export const WorkItemCommandInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create"),
    ...Command,
    projectId: ProjectId,
    title: WorkItem.fields.title,
    ...WorkItemSpecification.fields,
    priority: WorkItemPriority,
    sources: Schema.Array(WorkItemSource).check(Schema.isMaxLength(32)),
  }),
  Schema.Struct({
    type: Schema.Literal("update"),
    ...Existing,
    expectedVersion: Revision,
    title: WorkItem.fields.title,
    ...WorkItemSpecification.fields,
    priority: WorkItemPriority,
    sources: Schema.Array(WorkItemSource).check(Schema.isMaxLength(32)),
  }),
  Schema.Struct({
    type: Schema.Literal("start"),
    ...Existing,
    specRevision: Revision,
    participants: Schema.Array(WorkItemParticipant).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(20),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("stop"),
    ...Existing,
    executionId: Schema.optional(WorkItemExecutionId),
  }),
  Schema.Struct({
    type: Schema.Literal("report"),
    ...Existing,
    executionId: WorkItemExecutionId,
    specRevision: Revision,
    summary: Text,
    artifacts: Lines,
    submitted: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("submit"),
    ...Existing,
    expectedVersion: Revision,
    specRevision: Revision,
    executionIds: Schema.Array(WorkItemExecutionId),
    summary: Text,
    artifacts: Lines,
  }),
  Schema.Struct({
    type: Schema.Literal("review"),
    ...Existing,
    expectedVersion: Revision,
    decision: Schema.Literals(["accept", "changes"]),
    note: Text,
  }),
  Schema.Struct({ type: Schema.Literal("reopen"), ...Existing, expectedVersion: Revision }),
  Schema.Struct({
    type: Schema.Literal("archive"),
    ...Existing,
    expectedVersion: Revision,
    archived: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("move"),
    ...Existing,
    expectedVersion: Revision,
    status: Schema.Literals(["todo", "in_progress"]),
  }),
]);
export type WorkItemCommandInput = typeof WorkItemCommandInput.Type;
export const WorkItemMutationResult = Schema.Struct({ item: WorkItem });
export type WorkItemMutationResult = typeof WorkItemMutationResult.Type;
export const WorkItemDiscoverInput = Schema.Struct({
  projectId: ProjectId,
  dismissThreadId: Schema.optional(ThreadId),
});
export type WorkItemDiscoverInput = typeof WorkItemDiscoverInput.Type;
export const WorkItemDiscoverResult = Schema.Struct({
  candidates: Schema.Array(WorkItemCandidate),
});
export type WorkItemDiscoverResult = typeof WorkItemDiscoverResult.Type;
export class WorkItemError extends Schema.TaggedError<
  WorkItemError,
  { readonly brand: unique symbol }
>()("WorkItemError", {
  code: Schema.Literals([
    "not_found",
    "conflict",
    "invalid_state",
    "invalid_request",
    "persistence",
    "execution",
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

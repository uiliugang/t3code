import * as Schema from "effect/Schema";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BranchIssueRef } from "./branchIssues.ts";

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const References = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))).check(
  Schema.isMaxLength(100),
);
export const DeliveryService = Schema.Struct({
  appkey: TrimmedNonEmptyString,
  target: TrimmedNonEmptyString,
  revision: TrimmedNonEmptyString,
});
export const DeliveryScope = Schema.Struct({
  revision: Revision,
  confirmedRevision: Schema.NullOr(Revision),
  requiredPullRequests: References,
  changedServices: Schema.Array(DeliveryService).check(Schema.isMaxLength(100)),
});
export type DeliveryScope = typeof DeliveryScope.Type;
export const DeliveryEvidence = Schema.Struct({
  pullRequests: Schema.Array(Schema.Struct({ url: TrimmedNonEmptyString, merged: Schema.Boolean })),
  releases: Schema.Array(
    Schema.Struct({
      ...DeliveryService.fields,
      planId: TrimmedNonEmptyString,
      completed: Schema.Boolean,
    }),
  ),
  planIds: References,
  anomaly: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4000))),
});
export type DeliveryEvidence = typeof DeliveryEvidence.Type;
export const WorkItemDelivery = Schema.Struct({
  issue: BranchIssueRef,
  scope: DeliveryScope,
  evidence: DeliveryEvidence,
  dismissedThreadIds: Schema.optional(Schema.Array(ThreadId)),
  completionState: Schema.optional(TrimmedNonEmptyString),
  externalState: Schema.optional(Schema.String),
  syncedRevision: Schema.optional(Revision),
  lastSyncedAt: Schema.optional(IsoDateTime),
  syncError: Schema.optional(Schema.NullOr(Schema.String)),
  reopenRequest: Schema.optional(
    Schema.Struct({ scopeRevision: Revision, state: TrimmedNonEmptyString }),
  ),
});
export type WorkItemDelivery = typeof WorkItemDelivery.Type;
export const DeliverySummary = Schema.Struct({
  revision: Revision,
  progress: Schema.Literals([
    "needs_confirmation",
    "awaiting_merge",
    "awaiting_plan",
    "awaiting_release",
    "partially_released",
    "delivery_complete",
    "delivery_exception",
  ]),
  mergedPullRequests: Schema.Int,
  requiredPullRequests: Schema.Int,
  releasedServices: Schema.Int,
  changedServices: Schema.Int,
  synced: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type DeliverySummary = typeof DeliverySummary.Type;

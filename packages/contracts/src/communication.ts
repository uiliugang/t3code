import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PullRequestRef } from "./pullRequest.ts";

export const DaxiangRecipient = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/u),
);
export const DaxiangRecipients = Schema.Array(DaxiangRecipient).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(50),
);
export const DaxiangLinkInput = Schema.Struct({
  recipients: DaxiangRecipients,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  url: TrimmedNonEmptyString,
});
export type DaxiangLinkInput = typeof DaxiangLinkInput.Type;
export const DaxiangSendResult = Schema.Struct({
  recipients: Schema.Array(
    Schema.Struct({
      mis: DaxiangRecipient,
      status: Schema.Literals(["sent", "failed", "unknown"]),
    }),
  ),
});
export type DaxiangSendResult = typeof DaxiangSendResult.Type;
export const PullRequestSendReviewLinkInput = Schema.Struct({
  ...PullRequestRef.fields,
  reviewerMis: DaxiangRecipients,
});
export type PullRequestSendReviewLinkInput = typeof PullRequestSendReviewLinkInput.Type;
export class DaxiangSendError extends Schema.TaggedError<
  DaxiangSendError,
  { readonly brand: unique symbol }
>()("DaxiangSendError", {
  message: Schema.String,
}) {}

export const DaxiangApprovalKind = Schema.Literals([
  "pr",
  "mcm-plan",
  "mcm-event",
  "lion",
  "rds",
  "dms",
]);
export type DaxiangApprovalKind = typeof DaxiangApprovalKind.Type;

export const DaxiangApprovalOutcome = Schema.Literals([
  "approved",
  "notified",
  "opened",
  "skipped",
  "failed",
]);
export type DaxiangApprovalOutcome = typeof DaxiangApprovalOutcome.Type;

export const DaxiangApprovalRecord = Schema.Struct({
  id: Schema.String,
  kind: DaxiangApprovalKind,
  title: Schema.String,
  url: Schema.String,
  senderName: Schema.NullOr(Schema.String),
  outcome: DaxiangApprovalOutcome,
  detail: Schema.NullOr(Schema.String),
  browserOpened: Schema.Boolean,
  createdAt: Schema.Number,
});
export type DaxiangApprovalRecord = typeof DaxiangApprovalRecord.Type;

export const DaxiangApprovalStatus = Schema.Literals([
  "disabled",
  "missing_cli",
  "unauthenticated",
  "connecting",
  "listening",
  "error",
]);
export type DaxiangApprovalStatus = typeof DaxiangApprovalStatus.Type;

export class DaxiangApprovalError extends Schema.TaggedError<
  DaxiangApprovalError,
  { readonly brand: unique symbol }
>()("DaxiangApprovalError", {
  reason: Schema.Literals(["disabled", "missing_cli", "login_failed", "process_failed", "storage"]),
  detail: Schema.optional(Schema.String),
}) {
  override get message() {
    return this.detail ?? `DaXiang approval listener error: ${this.reason}.`;
  }
}

export const DaxiangApprovalState = Schema.Struct({
  status: DaxiangApprovalStatus,
  loggedIn: Schema.Boolean,
  uid: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  records: Schema.Array(DaxiangApprovalRecord),
});
export type DaxiangApprovalState = typeof DaxiangApprovalState.Type;

export const DaxiangApprovalMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["refresh", "restart", "clear_records"]),
  }),
  Schema.Struct({
    type: Schema.Literal("login"),
    port: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  }),
]);
export type DaxiangApprovalMutation = typeof DaxiangApprovalMutation.Type;

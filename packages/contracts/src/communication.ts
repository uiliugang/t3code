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

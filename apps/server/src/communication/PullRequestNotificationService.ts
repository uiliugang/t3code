import {
  DaxiangSendError,
  type DaxiangSendResult,
  type PullRequestSendReviewLinkInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import * as Daxiang from "./DaxiangMessageService.ts";

export class PullRequestNotificationService extends Context.Service<
  PullRequestNotificationService,
  {
    readonly sendReviewLink: (
      input: PullRequestSendReviewLinkInput,
    ) => Effect.Effect<DaxiangSendResult, DaxiangSendError>;
  }
>()("t3/communication/PullRequestNotificationService") {}

const make = Effect.gen(function* () {
  const pullRequests = yield* PullRequests.PullRequestService;
  const messages = yield* Daxiang.DaxiangMessageService;
  const sendReviewLink = Effect.fn("PullRequestNotificationService.sendReviewLink")(function* (
    input: PullRequestSendReviewLinkInput,
  ) {
    const detail = yield* pullRequests.detail({ ...input, allowStale: false }).pipe(
      Effect.mapError(
        () =>
          new DaxiangSendError({
            message: "Could not read the pull request. No message was sent.",
          }),
      ),
    );
    if (
      detail.provider !== "meituan" ||
      input.reviewerMis.some((mis) => !detail.reviewers.some((actor) => actor.login === mis))
    ) {
      return yield* new DaxiangSendError({
        message: "Select current reviewers of a Meituan Code pull request.",
      });
    }
    return yield* messages.sendLink({
      recipients: input.reviewerMis,
      title: `${detail.repository} #${detail.number}: ${detail.title}`,
      description: "请帮忙评审 PR：",
      url: detail.url,
    });
  });
  return PullRequestNotificationService.of({ sendReviewLink });
});
export const layer = Layer.effect(PullRequestNotificationService, make);

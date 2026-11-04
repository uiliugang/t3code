import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  SourceControlProviderKind,
  type DaxiangLinkInput,
  type PullRequestDetail,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import * as Daxiang from "./DaxiangMessageService.ts";
import * as Notifications from "./PullRequestNotificationService.ts";

it.effect("only sends the server's PR link to its current Meituan reviewers", () =>
  Effect.gen(function* () {
    const sent: DaxiangLinkInput[] = [];
    const detail = {
      provider: SourceControlProviderKind.make("meituan"),
      repository: "sa/beidou-dcim",
      number: 1111,
      title: "Feature",
      url: "https://dev.sankuai.com/code/repo-detail/sa/beidou-dcim/pr/1111/overview",
      projectId: ProjectId.make("project"),
      projectTitle: "Project",
      workspaceRoot: "/workspace",
      body: "",
      author: null,
      viewer: "author",
      state: "open",
      isDraft: false,
      mergeability: "unknown",
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      headBranch: "feature",
      baseBranch: "master",
      createdAt: "2026-11-04T00:00:00Z",
      updatedAt: "2026-11-04T00:00:00Z",
      mergedAt: null,
      closedAt: null,
      labels: [],
      checks: [],
      mergeCapabilities: { merge: false, squash: false, rebase: false },
      capabilities: {
        diff: true,
        comment: false,
        search: true,
        actions: [],
        mergeMethods: [],
        review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
        reviewers: { request: false, listCandidates: true },
        edit: { changeRequest: false, comment: false },
      },
      viewerPermissions: {
        actions: [],
        comment: false,
        resolve: false,
        verdicts: [],
        requestReviewers: false,
      },
      reviewers: [{ login: "alice", name: null, avatarUrl: null }],
    } satisfies PullRequestDetail;
    const input = {
      projectId: ProjectId.make("project"),
      repository: detail.repository,
      number: detail.number,
      reviewerMis: ["alice"],
    };
    yield* Effect.gen(function* () {
      const service = yield* Notifications.PullRequestNotificationService;
      yield* service.sendReviewLink(input);
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0], {
        recipients: ["alice"],
        title: "sa/beidou-dcim #1111: Feature",
        description: "请帮忙评审 PR：",
        url: detail.url,
      });
      yield* service
        .sendReviewLink({ ...input, reviewerMis: ["historical-reviewer"] })
        .pipe(Effect.flip);
      assert.equal(sent.length, 1);
    }).pipe(
      Effect.provide(
        Notifications.layer.pipe(
          Layer.provide(
            Layer.merge(
              Layer.mock(PullRequests.PullRequestService)({
                detail: (reference) => {
                  assert.equal(reference.allowStale, false);
                  return Effect.succeed(detail);
                },
              }),
              Layer.succeed(Daxiang.DaxiangMessageService, {
                sendLink: (message) =>
                  Effect.sync(() => {
                    sent.push(message);
                    return { recipients: [{ mis: "alice", status: "sent" }] };
                  }),
              }),
            ),
          ),
        ),
      ),
    );
  }),
);

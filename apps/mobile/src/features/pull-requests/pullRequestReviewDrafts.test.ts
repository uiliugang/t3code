import { describe, expect, it } from "vite-plus/test";

import {
  clearSubmittedReview,
  pullRequestReviewKey,
  type ReviewDraft,
} from "./pullRequestReviewDrafts";

const comment = {
  id: "one",
  path: "renamed.ts",
  oldPath: "old.ts",
  position: { kind: "deleted" as const, oldLine: 9 },
  body: "Keep this",
  headSha: "abc",
  code: "old line",
};
const draft: ReviewDraft = {
  summary: "Review",
  comment: "Separate PR comment",
  comments: [comment],
};
describe("mobile review draft recovery", () => {
  it("clears a submitted snapshot while retaining edits made during the request", () => {
    const current = {
      ...draft,
      summary: "New summary",
      comments: [
        { ...comment, body: "New feedback" },
        { ...comment, id: "two" },
      ],
    };
    expect(clearSubmittedReview(current, draft)).toEqual(current);
    expect(clearSubmittedReview(draft, draft)).toEqual({
      summary: "",
      comment: draft.comment,
      comments: [],
    });
  });
});

it("reuses a legacy draft for public GitHub without exposing it to another Web origin", () => {
  const params = {
    environmentId: "env",
    projectId: "project",
    host: "github.com",
    repository: "acme/app",
    number: 7,
  };
  const oldKey = JSON.stringify(["env", "project", "github.com", "acme/app", 7]);
  expect(
    pullRequestReviewKey({ ...params, navigationUrl: "https://github.com/acme/app/pull/7" }),
  ).toBe(oldKey);
  expect(
    pullRequestReviewKey({
      ...params,
      host: "github.com:8443",
      navigationUrl: "https://github.com:8443/acme/app/pull/7",
    }),
  ).not.toBe(oldKey);
});

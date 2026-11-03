import { describe, expect, it } from "@effect/vitest";
import { branchIssuePlaceholder, parseBranchIssueUrl } from "./branchIssues.ts";

describe("branch issue links", () => {
  it.each([
    ["https://github.com/t3tools/t3code/issues/42?x=1#body", "github", "t3tools/t3code", "42"],
    [
      "https://mep.sankuai.com/app/ones/space/123/workItem/devtask/detail/456",
      "meituan",
      "123",
      "456",
    ],
    [
      "https://mep.sankuai.com/app/ones/space/123/workItem/requirement?viewId=42&openDrawerIssueType=REQUIREMENT&openDrawerIssueId=789&openDrawerSpaceId=123&process=release",
      "meituan",
      "123",
      "789",
    ],
  ])("parses and canonicalizes %s", (url, provider, repository, id) => {
    const result = parseBranchIssueUrl(url);
    expect(result).toMatchObject({ provider, repository, id });
    expect(result?.url).not.toContain("?");
    expect(parseBranchIssueUrl(result!.url)).toEqual(result);
  });

  it.each([
    "https://github.com/owner/repo/pull/42",
    "https://github.com.evil.test/owner/repo/issues/42",
    "https://user:secret@github.com/owner/repo/issues/42",
    "https://mep.sankuai.com/app/ones/space/123/workItem/requirement?openDrawerIssueId=-1",
    "https://mep.sankuai.com/app/ones/space/123/workItem/requirement",
    "javascript:alert(1)",
  ])("rejects non-issue or unsafe URLs %s", (url) => expect(parseBranchIssueUrl(url)).toBeNull());

  it("uses platform-specific input hints", () => {
    expect(branchIssuePlaceholder("github")).toContain("GitHub Issue");
    expect(branchIssuePlaceholder("github")).not.toContain("MEP");
    expect(branchIssuePlaceholder("meituan")).toContain("MEP ONES");
    expect(branchIssuePlaceholder("meituan")).not.toContain("GitHub");
  });
});

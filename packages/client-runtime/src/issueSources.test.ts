import { describe, expect, it } from "vite-plus/test";
import { ProjectId, mergeProjectIssueSources } from "@t3tools/contracts";

import {
  canBindUndetectedProject,
  detectedProjectIssueKind,
  listedProjectIssueSources,
  issueSourceProjectIdBatches,
  parseMepSpaceIds,
  projectIssueSourceEdit,
  withGithubRepositoryOverride,
  withMepSpaceOverrides,
} from "./issueSources.ts";

describe("mergeProjectIssueSources", () => {
  it("uses the repository provider for legacy mixed settings without losing same-provider scopes", () => {
    const sources = [
      { provider: "github", host: "github.com", scope: "owner/repository" },
      { provider: "meituan", host: "mep.sankuai.com", scope: "1031008" },
      { provider: "meituan", host: "mep.sankuai.com", scope: "1031009" },
    ] as const;

    expect(mergeProjectIssueSources([], sources, "github")).toEqual([sources[0]]);
    expect(detectedProjectIssueKind(undefined, { sources: sources.slice(1) })).toBe("meituan");
    expect(mergeProjectIssueSources([], sources, "meituan")).toEqual(sources.slice(1));
    expect(mergeProjectIssueSources([], sources)).toEqual([sources[0]]);
    expect(mergeProjectIssueSources([sources[0]], sources.slice(1))).toEqual([sources[0]]);
    expect(listedProjectIssueSources(false, [sources[0]], sources.slice(1), "github")).toEqual(
      sources,
    );
    expect(listedProjectIssueSources(true, [sources[0]], sources.slice(1), "github")).toEqual([
      sources[0],
    ]);
    expect(parseMepSpaceIds("2， 3, 2")).toEqual(["2", "3"]);
    for (const invalid of ["", "0", "1, x", "01", "1".repeat(201)])
      expect(parseMepSpaceIds(invalid)).toBeNull();
    const manual = withMepSpaceOverrides(["42"]);
    expect(mergeProjectIssueSources(sources, manual, "meituan")).toEqual([
      { ...sources[1], scope: "42" },
    ]);
    expect(mergeProjectIssueSources(sources, [], "meituan")).toEqual(sources.slice(1));
  });
  it("allows first-time binding after the legacy server's non-repository response only", () => {
    const error =
      "Could not resolve this project's repository. Check that its workspace exists and is a Git repository.";
    expect(canBindUndetectedProject(false, "failed", error)).toBe(true);
    expect(canBindUndetectedProject(true, "failed", error)).toBe(false);
    expect(canBindUndetectedProject(false, "failed", "Connection lost")).toBe(false);
    expect(canBindUndetectedProject(false, "pending")).toBe(false);
  });
  it("edits one GitHub repository and keeps only scopes on the same platform", () => {
    const first = { provider: "github", host: "github.com", scope: "team/app" } as const;
    const second = { ...first, host: "git.example.com" };
    const space = { provider: "meituan", host: "mep.sankuai.com", scope: "42" } as const;
    const saved = [first, space, second];
    expect(withGithubRepositoryOverride(saved, first, first.scope)).toEqual([first, second]);
    expect(withGithubRepositoryOverride(saved, second, "team/next")).toEqual([
      first,
      { ...second, scope: "team/next" },
    ]);
    expect(withGithubRepositoryOverride(saved, first, null)).toEqual([second]);
    const legacy = [{ ...first, host: "GitHub.com:443", scope: "Team/App" }, first, second];
    expect(withGithubRepositoryOverride(legacy, first, null)).toEqual([second]);
    expect(withGithubRepositoryOverride(legacy, first, first.scope)).toEqual([first, second]);
    expect(listedProjectIssueSources(true, [], legacy, "github")).toEqual([legacy[0], second]);
    expect(listedProjectIssueSources(false, [], legacy, "github")).toEqual([legacy[0], second]);
    expect(withGithubRepositoryOverride([space], second, "team/new")).toEqual([
      { ...second, scope: "team/new" },
    ]);
    expect(withGithubRepositoryOverride([], undefined, first.scope)).toEqual([first]);
    const renamed = { ...first, scope: "team/next" };
    expect(withGithubRepositoryOverride([first, renamed, space], first, "TEAM/next")).toEqual([
      renamed,
    ]);
  });
  it("refuses stale edits even when another provider changed", () => {
    const id = ProjectId.make("project");
    const github = { provider: "github", host: "github.com", scope: "team/original" } as const;
    const latest = { ...github, scope: "team/renamed" };
    const patch = projectIssueSourceEdit(id, false, "meituan", [latest], [github], () =>
      withMepSpaceOverrides(["42"]),
    );
    expect(patch).toBeNull();
    expect(projectIssueSourceEdit(id, true, "github", [latest], [github], () => [])).toBeNull();
  });
  it("sends the full legacy source list but scopes writes to a capable server", () => {
    const id = ProjectId.make("project");
    const github = { provider: "github", host: "github.com", scope: "team/original" } as const;
    const oldSpace = withMepSpaceOverrides(["41"])[0]!;
    const saved = [github, oldSpace];
    const replacement = withMepSpaceOverrides(["42"]);
    expect(projectIssueSourceEdit(id, false, "meituan", saved, saved, () => replacement)).toEqual({
      expectedIssueProjectSources: { [id]: saved },
      patch: { issueProjectSources: { [id]: [github, ...replacement] } },
    });
    expect(projectIssueSourceEdit(id, true, "meituan", saved, saved, () => replacement)).toEqual({
      issueSourceProvider: "meituan",
      expectedIssueProjectSources: { [id]: saved },
      patch: { issueProjectSources: { [id]: replacement } },
    });
  });
  it("batches more than 500 projects without dropping the remainder", () => {
    const projectIds = Array.from({ length: 501 }, (_, index) =>
      ProjectId.make(`project-${index}`),
    );

    expect(issueSourceProjectIdBatches(projectIds).map((batch) => batch.length)).toEqual([500, 1]);
    expect(issueSourceProjectIdBatches(projectIds).flat()).toEqual(projectIds);
  });
});

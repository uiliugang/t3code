import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@t3tools/contracts";

import {
  issueSourceProjectIdBatches,
  mergeProjectIssueSources,
  parseMepSpaceIds,
  projectIssueSourceEdit,
  withGithubRepositoryOverride,
  withMepSpaceOverrides,
} from "./issueSources.ts";

describe("mergeProjectIssueSources", () => {
  it("keeps discovered MEP spaces alongside GitHub Issues", () => {
    const sources = [
      { provider: "github", host: "github.com", scope: "owner/repository" },
      { provider: "meituan", host: "mep.sankuai.com", scope: "1031008" },
      { provider: "meituan", host: "mep.sankuai.com", scope: "1031009" },
    ] as const;

    expect(mergeProjectIssueSources(sources, [])).toEqual(sources);
    expect(parseMepSpaceIds("2， 3, 2")).toEqual(["2", "3"]);
    for (const invalid of ["", "0", "1, x", "01", "1".repeat(201)])
      expect(parseMepSpaceIds(invalid)).toBeNull();
    const manual = withMepSpaceOverrides(sources, ["42"]);
    expect(manual).toEqual([sources[0], { ...sources[1], scope: "42" }]);
    const restored = withMepSpaceOverrides(manual, []);
    expect(restored).toEqual([sources[0]]);
    expect(mergeProjectIssueSources(sources, restored)).toEqual([
      sources[1],
      sources[2],
      sources[0],
    ]);
  });
  it("edits or removes one GitHub repository without discarding other sources", () => {
    const first = { provider: "github", host: "github.com", scope: "team/app" } as const;
    const second = { ...first, host: "git.example.com" };
    const space = { provider: "meituan", host: "mep.sankuai.com", scope: "42" } as const;
    const saved = [first, space, second];
    expect(withGithubRepositoryOverride(saved, first, first.scope)).toEqual(saved);
    expect(withGithubRepositoryOverride(saved, second, "team/next")).toEqual([
      first,
      space,
      { ...second, scope: "team/next" },
    ]);
    expect(withGithubRepositoryOverride(saved, first, null)).toEqual([space, second]);
    expect(withGithubRepositoryOverride([space], second, "team/new")).toEqual([
      space,
      { ...second, scope: "team/new" },
    ]);
    expect(withGithubRepositoryOverride([], undefined, first.scope)).toEqual([first]);
    const renamed = { ...first, scope: "team/next" };
    expect(withGithubRepositoryOverride([first, renamed, space], first, renamed.scope)).toEqual([
      renamed,
      space,
    ]);
  });
  it("keeps live changes on servers that only accept whole-project replacements", () => {
    const id = ProjectId.make("project");
    const github = { provider: "github", host: "github.com", scope: "team/original" } as const;
    const latest = { ...github, scope: "team/renamed" };
    const patch = projectIssueSourceEdit(id, "meituan", [latest], [github], (saved) =>
      withMepSpaceOverrides(saved, ["42"]),
    );
    expect(patch?.patch.issueProjectSources[id]).toEqual([
      latest,
      { provider: "meituan", host: "mep.sankuai.com", scope: "42" },
    ]);
    expect(projectIssueSourceEdit(id, "github", [latest], [github], () => [])).toBeNull();
  });
  it("batches more than 500 projects without dropping the remainder", () => {
    const projectIds = Array.from({ length: 501 }, (_, index) =>
      ProjectId.make(`project-${index}`),
    );

    expect(issueSourceProjectIdBatches(projectIds).map((batch) => batch.length)).toEqual([500, 1]);
    expect(issueSourceProjectIdBatches(projectIds).flat()).toEqual(projectIds);
  });
});

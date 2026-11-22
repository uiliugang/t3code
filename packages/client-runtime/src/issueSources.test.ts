import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@t3tools/contracts";

import {
  issueSourceProjectIdBatches,
  mergeProjectIssueSources,
  parseMepSpaceIds,
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
  it("batches more than 500 projects without dropping the remainder", () => {
    const projectIds = Array.from({ length: 501 }, (_, index) =>
      ProjectId.make(`project-${index}`),
    );

    expect(issueSourceProjectIdBatches(projectIds).map((batch) => batch.length)).toEqual([500, 1]);
    expect(issueSourceProjectIdBatches(projectIds).flat()).toEqual(projectIds);
  });
});

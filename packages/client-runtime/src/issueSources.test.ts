import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@t3tools/contracts";

import { issueSourceProjectIdBatches, mergeProjectIssueSources } from "./issueSources.ts";

describe("mergeProjectIssueSources", () => {
  it("keeps discovered MEP spaces alongside GitHub Issues", () => {
    const sources = [
      { provider: "github", host: "github.com", scope: "owner/repository" },
      { provider: "meituan", host: "mep.sankuai.com", scope: "1031008" },
      { provider: "meituan", host: "mep.sankuai.com", scope: "1031009" },
    ] as const;

    expect(mergeProjectIssueSources(sources, [])).toEqual(sources);
  });
  it("batches more than 500 projects without dropping the remainder", () => {
    const projectIds = Array.from({ length: 501 }, (_, index) =>
      ProjectId.make(`project-${index}`),
    );

    expect(issueSourceProjectIdBatches(projectIds).map((batch) => batch.length)).toEqual([500, 1]);
    expect(issueSourceProjectIdBatches(projectIds).flat()).toEqual(projectIds);
  });
});

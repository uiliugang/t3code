import { describe, expect, it } from "vite-plus/test";

import { mergeProjectIssueSources } from "./requirementsSettings.logic";

describe("mergeProjectIssueSources", () => {
  it("keeps discovered MEP spaces alongside GitHub Issues", () => {
    const sources = [
      { provider: "github", host: "github.com", scope: "owner/repository" },
      { provider: "meituan", host: "mep.sankuai.com", scope: "1031008" },
      { provider: "meituan", host: "mep.sankuai.com", scope: "1031009" },
    ] as const;

    expect(mergeProjectIssueSources(sources, [])).toEqual(sources);
  });
});

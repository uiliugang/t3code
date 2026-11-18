import { ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestSyncKey } from "./pullRequestSyncKey.ts";

describe("pullRequestSyncKey", () => {
  const reference = { projectId: ProjectId.make("project"), repository: "web", number: 7 };
  it("derives the GitLab host for a reference to a checkout", () => {
    const identity = {
      canonicalKey: "gitlab.com/org/team/web",
      provider: SourceControlProviderKind.make("gitlab"),
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@gitlab.com:org/team/web.git",
      },
    };
    expect(pullRequestSyncKey({ ...reference, repository: "org/team/web" }, identity)).toEqual({
      host: "gitlab.com",
      repository: "org/team/web",
      number: 7,
    });
  });
  it("normalizes complete hosted aliases without requiring a checkout", () => {
    expect(
      pullRequestSyncKey({
        ...reference,
        host: "org.visualstudio.com",
        repository: "project/_git/web",
      }),
    ).toEqual({ host: "dev.azure.com", repository: "org/project/_git/web", number: 7 });
    expect(
      pullRequestSyncKey({ ...reference, host: "github.com", repository: "acme/web" }),
    ).toEqual({ host: "github.com", repository: "acme/web", number: 7 });
    expect(pullRequestSyncKey(reference)).toBeNull();
  });
});

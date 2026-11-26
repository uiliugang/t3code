import {
  EnvironmentId,
  ProjectId,
  type RepositoryIdentity,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  changeRequestFallback,
  findProjectForChangeRequest,
  findProjectOnChangeRequestHost,
  projectChangeRequestUrl,
  resolveChangeRequestLinkTarget,
  resolvePullRequestPreviewTarget,
} from "./changeRequestLinks.ts";

describe("findProjectForChangeRequest", () => {
  const project = (identity: Record<string, unknown>) =>
    ({ id: "p1", repositoryIdentity: identity }) as never;

  it("matches a nested GitLab group by the whole path below the host", () => {
    const projects = [
      project({
        canonicalKey: "gitlab.com/t3tools/platform/t3code",
        provider: SourceControlProviderKind.make("gitlab"),
        displayName: "t3tools/platform/t3code",
        owner: "t3tools",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForChangeRequest(
        projects,
        {
          host: "gitlab.com",
          repository: "t3tools/platform/t3code",
          number: 42,
        },
        "gitlab",
      ),
    ).toBe(projects[0]);
  });

  it("claims nothing for a lookalike host, which is what keeps a link a link", () => {
    const projects = [
      project({
        canonicalKey: "github.com/pingdotgg/t3code",
        provider: SourceControlProviderKind.make("github"),
        owner: "pingdotgg",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForChangeRequest(
        projects,
        {
          host: "github.com-evil.test",
          repository: "pingdotgg/t3code",
          number: 1,
        },
        "github",
      ),
    ).toBeUndefined();
  });
});

describe("findProjectOnChangeRequestHost", () => {
  const project = (id: string, identity: Record<string, unknown>) =>
    ({ id, repositoryIdentity: identity }) as never;
  const frontend = project("frontend", {
    canonicalKey: "github.com/acme/frontend",
    provider: "github",
    owner: "acme",
    name: "frontend",
  });
  const backend = project("backend", {
    canonicalKey: "github.com/acme/backend",
    provider: "github",
    owner: "acme",
    name: "backend",
  });

  it("prefers the project checked out from the link's own repository", () => {
    expect(
      findProjectOnChangeRequestHost(
        [frontend, backend],
        {
          host: "github.com",
          repository: "acme/backend",
          number: 7,
        },
        "github",
      ),
    ).toBe(backend);
  });

  it("lends any project on the host to a repository nobody has checked out", () => {
    expect(
      findProjectOnChangeRequestHost(
        [frontend],
        {
          host: "github.com",
          repository: "acme/backend",
          number: 7,
        },
        "github",
      ),
    ).toBe(frontend);
  });
});

describe("changeRequestFallback", () => {
  const gitlab = (remoteUrl: string): RepositoryIdentity => ({
    canonicalKey: "forge.test/acme/app",
    provider: SourceControlProviderKind.make("gitlab"),
    displayName: "acme/app",
    locator: { source: "git-remote", remoteName: "origin", remoteUrl },
  });
  const ref = { host: "forge.test", repository: "acme/app", number: 7 };
  const checkout = gitlab("https://forge.test/acme/app.git");

  it("uses the verified GitHub target when the originating project uses GitLab", () => {
    const url = "https://enterprise.test:8443/acme/app/pull/7";
    expect(
      changeRequestFallback({ ...ref, host: "enterprise.test:8443" }, checkout, url),
    ).toMatchObject({ url, definition: { kind: "github" } });
  });

  it("does not confuse GitLab HTTP and HTTPS origins", () => {
    const url = "http://forge.test/acme/app/-/merge_requests/7";
    const httpCheckout = gitlab("http://forge.test/acme/app.git");
    expect(changeRequestFallback(ref, checkout, url)).toBeNull();
    expect(changeRequestFallback(ref, httpCheckout, url)?.url).toBe(url);
    expect(changeRequestFallback({ ...ref, host: "forge.test:80" }, httpCheckout)).toBeNull();
  });
});

describe("resolveChangeRequestLinkTarget", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const project = (id: string, environmentId: EnvironmentId, canonicalKey: string) => ({
    id: ProjectId.make(id),
    environmentId,
    repositoryIdentity: {
      canonicalKey,
      provider: SourceControlProviderKind.make(
        canonicalKey.startsWith("git.cafe") ? "gitcafe" : "github",
      ),
      displayName: canonicalKey.split("/").slice(1).join("/"),
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${canonicalKey}` },
    } satisfies RepositoryIdentity,
  });
  const mirrored = project("mirrored", local, "git.cafe/acme/app");
  const sibling = project("sibling", local, "github.com/acme/tools");
  const elsewhere = project("elsewhere", remote, "github.com/acme/app");
  const projects = [mirrored, sibling, elsewhere];
  const loaded = () => true;
  const url = "https://github.com/acme/app/pull/7";

  it("routes identical GitHub repositories by HTTPS authority", () => {
    const standard = project("standard", local, "forge.test/acme/app");
    const withRemote = (id: string, remoteUrl: string) => ({
      ...standard,
      id: ProjectId.make(id),
      repositoryIdentity: {
        ...standard.repositoryIdentity,
        locator: { ...standard.repositoryIdentity.locator, remoteUrl },
      },
    });
    const custom = withRemote("custom", "https://forge.test:8443/acme/app.git");
    const ssh = withRemote("ssh", "git@forge.test:acme/app.git");
    const resolve = (host: string, projects: ReadonlyArray<typeof standard>) =>
      resolveChangeRequestLinkTarget({
        url: `https://${host}/acme/app/pull/7`,
        projects,
        configLoaded: loaded,
        lendHostProject: true,
      });
    expect(resolve("forge.test:8443", [standard, ssh, custom])).toMatchObject({
      project: custom,
      host: "forge.test:8443",
    });
    expect(resolve("forge.test:8443", [standard, ssh])).toBeNull();
    expect(resolve("forge.test", [custom, standard])).toMatchObject({ project: standard });
    expect(resolve("forge.test", [custom])).toBeNull();
  });

  it("does not open or preview a GitHub PR through a GitLab checkout on the same authority", () => {
    const github = project("github", local, "forge.test/acme/app");
    const gitlab = {
      ...github,
      id: ProjectId.make("gitlab"),
      repositoryIdentity: {
        ...github.repositoryIdentity,
        provider: SourceControlProviderKind.make("gitlab"),
      },
    };
    const enterpriseUrl = "https://forge.test/acme/app/pull/7";
    expect(
      resolveChangeRequestLinkTarget({
        url: enterpriseUrl,
        projects: [gitlab],
        configLoaded: loaded,
        lendHostProject: true,
      }),
    ).toBeNull();
    expect(
      resolvePullRequestPreviewTarget({
        url: enterpriseUrl,
        projects: [gitlab, github],
        environmentId: local,
        pullRequestsEnabled: true,
      })?.input.projectId,
    ).toBe(github.id);
  });

  it("does not borrow an HTTPS GitLab checkout for an HTTP MR link", () => {
    const https = project("https", local, "forge.test/acme/app");
    const gitlab = {
      ...https,
      repositoryIdentity: {
        ...https.repositoryIdentity,
        provider: SourceControlProviderKind.make("gitlab"),
      },
    };
    expect(
      resolveChangeRequestLinkTarget({
        url: "http://forge.test/acme/app/-/merge_requests/7",
        projects: [gitlab],
        configLoaded: loaded,
        lendHostProject: true,
      }),
    ).toBeNull();
  });

  it("lets the server verify an HTTP MR link opened from a GitLab SSH checkout", () => {
    const base = project("ssh", local, "forge.test/acme/app");
    const gitlab = {
      ...base,
      repositoryIdentity: {
        ...base.repositoryIdentity,
        provider: SourceControlProviderKind.make("gitlab"),
        locator: { ...base.repositoryIdentity.locator, remoteUrl: "git@forge.test:acme/app.git" },
      },
    };
    const url = "http://forge.test/acme/app/-/merge_requests/7";
    expect(
      resolveChangeRequestLinkTarget({
        url,
        projects: [gitlab],
        configLoaded: loaded,
        lendHostProject: true,
      }),
    ).toMatchObject({ project: gitlab, host: "forge.test", repository: "acme/app", number: 7 });
    expect(
      resolvePullRequestPreviewTarget({
        environmentId: local,
        projects: [gitlab],
        pullRequestsEnabled: true,
        url,
      })?.input.target,
    ).toEqual({ provider: "gitlab", origin: "http://forge.test" });
  });

  it("opens a mirror's link in its own environment under a project on the link's host", () => {
    expect(
      resolveChangeRequestLinkTarget({
        url,
        projects,
        configLoaded: loaded,
        environmentId: local,
        projectId: mirrored.id,
        lendHostProject: true,
      }),
    ).toEqual({ project: sibling, host: "github.com", repository: "acme/app", number: 7 });
  });

  it("only borrows a host project for views that can show any repository on the host", () => {
    expect(
      resolveChangeRequestLinkTarget({
        url,
        projects,
        configLoaded: loaded,
        environmentId: local,
        lendHostProject: false,
      }),
    ).toBeNull();
  });

  it("finds the checked-out repository in any environment that reads change requests", () => {
    expect(
      resolveChangeRequestLinkTarget({
        url,
        projects,
        configLoaded: loaded,
        primaryEnvironmentId: local,
        lendHostProject: false,
      })?.project,
    ).toBe(elsewhere);
    expect(
      resolveChangeRequestLinkTarget({
        url,
        projects,
        configLoaded: (environmentId) => environmentId !== remote,
        lendHostProject: false,
      }),
    ).toBeNull();
  });
});

describe("resolvePullRequestPreviewTarget", () => {
  const environmentId = EnvironmentId.make("env-1");
  const project = {
    id: ProjectId.make("project-1"),
    environmentId,
    repositoryIdentity: {
      canonicalKey: "github.com/acme/web",
      provider: SourceControlProviderKind.make("github"),
      displayName: "acme/web",
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:acme/web" },
    } satisfies RepositoryIdentity,
  };

  it("previews a pull request only under the project that holds its repository", () => {
    const target = (url: string) =>
      resolvePullRequestPreviewTarget({
        environmentId,
        projects: [project],
        pullRequestsEnabled: true,
        url,
      });
    expect(target("https://github.com/acme/web/pull/7")).toEqual({
      environmentId,
      input: {
        projectId: project.id,
        host: "github.com",
        target: { provider: "github", origin: "https://github.com" },
        repository: "acme/web",
        number: 7,
      },
    });
    expect(target("https://github.com/acme/other/pull/7")).toBeNull();
  });

  it("previews a Meituan Code browser link through its RPC origin", () => {
    const meituan = {
      ...project,
      repositoryIdentity: {
        canonicalKey: "git.sankuai.com/sa/web",
        displayName: "sa/web",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "git@git.sankuai.com:sa/web.git",
        },
        provider: SourceControlProviderKind.make("meituan"),
      } satisfies RepositoryIdentity,
    };
    expect(
      resolvePullRequestPreviewTarget({
        environmentId,
        projects: [meituan],
        pullRequestsEnabled: true,
        url: "https://dev.sankuai.com/code/repo-detail/SA/Web/pr/22/overview?codeArea=mcode",
      })?.input,
    ).toMatchObject({
      host: "git.sankuai.com",
      target: { provider: "meituan", origin: "https://git.sankuai.com" },
    });
  });
});

describe("projectChangeRequestUrl", () => {
  const identity = (provider: string): RepositoryIdentity => ({
    canonicalKey: "github.com/acme/default",
    provider: SourceControlProviderKind.make(provider),
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:acme/default",
    },
  });

  it("builds the requested repository's URL on the project's host", () => {
    expect(projectChangeRequestUrl(identity("github"), "acme/other", 42)).toBe(
      "https://github.com/acme/other/pull/42",
    );
  });

  it("builds nothing without a project host that knows its URL shape", () => {
    expect(projectChangeRequestUrl(identity("azure-devops"), "acme/repository", 1)).toBeNull();
    expect(projectChangeRequestUrl(null, "acme/repository", 1)).toBeNull();
    expect(projectChangeRequestUrl(identity("unknown"), "acme/repository", 1)).toBeNull();
    const { provider: _provider, ...withoutProvider } = identity("github");
    expect(projectChangeRequestUrl(withoutProvider, "acme/repository", 1)).toBeNull();
  });
});

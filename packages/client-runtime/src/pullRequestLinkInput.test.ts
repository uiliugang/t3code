import { describe, expect, it } from "vite-plus/test";

import { sourceControlClients } from "./sourceControlClients.ts";

import { parsePullRequestReference, resolveLinkPullRequestInput } from "./pullRequestLinkInput.ts";

const changeRequestWebUrl = (kind: string, host: string, repository: string, number: number) =>
  sourceControlClients.get(kind).changeRequestUrl({ host, repository, number });

const project = {
  host: "github.com",
  repository: "acme/web",
  terminology: sourceControlClients.get("github").changeRequest,
  webUrl: (number: number) => changeRequestWebUrl("github", "github.com", "acme/web", number),
};

describe("resolveLinkPullRequestInput", () => {
  it.each([
    ["https://github.acme.test/acme/web/pull/42", "github.acme.test"],
    ["https://git.acme.test/acme/web/-/merge_requests/42", "git.acme.test"],
  ])("links supported host URL %s without a thread project", (url, host) => {
    expect(
      resolveLinkPullRequestInput({
        reference: ` ${url} `,
        project: null,
        hasProject: (candidate) => candidate.host === host,
      }),
    ).toEqual({ link: { host, repository: "acme/web", number: 42, url } });
  });

  it("resolves a bare number against the thread's own repository", () => {
    expect(
      resolveLinkPullRequestInput({ reference: "#42", project, hasProject: () => true }),
    ).toEqual({
      link: {
        host: "github.com",
        repository: "acme/web",
        number: 42,
        url: "https://github.com/acme/web/pull/42",
      },
    });
  });

  it("names the project host's change request when it has no URL for a number", () => {
    expect(
      resolveLinkPullRequestInput({
        reference: "#42",
        project: {
          ...project,
          terminology: sourceControlClients.get("gitlab").changeRequest,
          webUrl: () => null,
        },
        hasProject: () => true,
      }),
    ).toEqual({
      error: "Paste a full URL; this project's host has no known merge request URL.",
    });
  });

  it("links a URL from another repository on a host with a project", () => {
    expect(
      resolveLinkPullRequestInput({
        reference: "https://github.com/acme/api/pull/7",
        project,
        hasProject: (reference) => reference.host === "github.com",
      }),
    ).toEqual({
      link: {
        host: "github.com",
        repository: "acme/api",
        number: 7,
        url: "https://github.com/acme/api/pull/7",
      },
    });
  });

  it("refuses a URL on a host nothing is checked out from", () => {
    const result = resolveLinkPullRequestInput({
      reference: "https://gitlab.com/acme/api/-/merge_requests/7",
      project,
      hasProject: () => false,
    });
    expect(result).toMatchObject({ error: expect.stringContaining("gitlab.com") });
  });
});

describe("parsePullRequestReference", () => {
  it.each([
    "https://code.example.com/group/project/-/merge_requests/42",
    "http://git.internal/group/sub/project/-/merge_requests/7",
  ])("accepts self-hosted GitLab merge request URL %s", (url) => {
    expect(parsePullRequestReference(url)).toBe(url);
  });

  it.each([
    "https://github.acme.test/acme/web/pull/42",
    "https://git.corp.example/acme/web/pull/42/files?diff=split",
  ])("accepts GitHub Enterprise Server pull request URL %s", (url) => {
    expect(parsePullRequestReference(url)).toBe(url);
    expect(parsePullRequestReference(`gh pr checkout ${url}`)).toBe(url);
  });

  it("accepts gh pr checkout commands with raw numbers", () => {
    expect(parsePullRequestReference("gh pr checkout 42")).toBe("42");
  });

  it("accepts glab mr checkout commands with raw numbers", () => {
    expect(parsePullRequestReference("glab mr checkout 42")).toBe("42");
  });

  it("rejects az repos pr checkout commands with equals-style ids", () => {
    expect(parsePullRequestReference("az repos pr checkout --id=42")).toBeNull();
  });

  it("rejects az repos pr checkout commands with extra flags", () => {
    expect(
      parsePullRequestReference("az repos pr checkout --id 42 --remote-name origin"),
    ).toBeNull();
  });

  it("rejects non-pull-request input", () => {
    expect(parsePullRequestReference("feature/my-branch")).toBeNull();
  });
});

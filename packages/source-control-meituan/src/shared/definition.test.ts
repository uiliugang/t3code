import { describe, expect, it } from "vite-plus/test";
import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";
import { definition, parsePullRequestUrl } from "./definition.ts";

describe("Meituan Code identity", () => {
  it.each([
    "https://dev.sankuai.com/code/repo-detail/SA/Web/pr/22/overview?codeArea=mcode",
    "https://git.sankuai.com/projects/SA/repos/Web/pull-requests/22/overview",
  ])("maps %s to the Git repository host", (url) => {
    expect(parsePullRequestUrl(url)).toEqual({
      host: "git.sankuai.com",
      repository: "sa/web",
      number: 22,
      repositoryUrl: "https://dev.sankuai.com/code/repo-detail/sa/web",
    });
  });
  it.each([
    "https://dev.sankuai.com.evil.test/code/repo-detail/sa/web/pr/22",
    "https://github.com/sa/web/pull/22",
    "https://dev.sankuai.com/code/repo-detail/sa/web/pr/0",
    "https://dev.sankuai.com/code/repo-detail/sa/web/pr/22extra",
    "https://dev.sankuai.com/code/repo-detail/sa/web/pr/9007199254740992",
    "ftp://dev.sankuai.com/code/repo-detail/sa/web/pr/22",
    "https://user:password@dev.sankuai.com/code/repo-detail/sa/web/pr/22",
  ])("does not claim %s", (url) => expect(parsePullRequestUrl(url)).toBeNull());
  it.each([
    "ssh://git@git.sankuai.com/sa/web.git",
    "git@git.sankuai.com:sa/web.git",
    "https://git.sankuai.com/scm/sa/web.git",
  ])("recognizes %s", (remote) => {
    expect(recognizeRemoteWith(definition, remote)?.kind).toBe("meituan");
  });
  it("does not classify unrelated hosts as Meituan Code", () => {
    expect(
      recognizeRemoteWith(definition, "ssh://git@git.sankuai.com.evil.test/sa/web.git"),
    ).toBeNull();
    expect(recognizeRemoteWith(definition, "https://bitbucket.org/sa/web.git")).toBeNull();
  });
  it("treats SCM HTTPS remotes and SSH remotes as the same repository", () => {
    expect(definition.repositoryKeyFromRemote("git.sankuai.com/scm/SA/Web")).toBe(
      "git.sankuai.com/sa/web",
    );
    expect(definition.canonicalRepositoryKey("git.sankuai.com/sa/web")).toBe(
      "git.sankuai.com/sa/web",
    );
    expect(definition.canonicalRepositoryKey("github.com/sa/web")).toBeNull();
  });
});

import { expect, it } from "@effect/vitest";

import {
  BUILT_IN_SOURCE_CONTROL_DRIVER_LIST,
  sourceControlDefinitions,
} from "./sourceControlDefinitions.ts";

it("runs a driver for every host the server and clients read, in their order", () => {
  expect(BUILT_IN_SOURCE_CONTROL_DRIVER_LIST.map((driver) => driver.definition)).toEqual(
    sourceControlDefinitions.definitions,
  );
});

it("only registers GitHub, GitLab and Meituan Code", () => {
  expect(sourceControlDefinitions.definitions.map((definition) => definition.kind)).toEqual([
    "github",
    "gitlab",
    "meituan",
  ]);
  expect(
    sourceControlDefinitions.recognizeRemote("git@git.sankuai.com:project/repo.git")?.kind,
  ).toBe("meituan");
  expect(
    sourceControlDefinitions.parseChangeRequestUrl(
      "https://dev.sankuai.com/code/repo-detail/project/repo/pr/42/overview",
    )?.definition.kind,
  ).toBe("meituan");
});

it.each([
  "C:/repos/project",
  "C:\\repos\\project",
  "/srv/git/repo.git",
  "./team:group/repo",
  "file:///srv/git/repo.git",
  "hg::team/repo",
  "codecommit::us-east-1://repo",
])("finds no host in %s, which git does not read as SSH", (remoteUrl) => {
  expect(sourceControlDefinitions.recognizeRemote(remoteUrl)).toBeNull();
});

it.each([
  ["https://github.com/Acme/Web/issues/42", "github", "github.com", "acme/web", "42"],
  [
    "https://gitlab.acme.test/group/sub/web/-/issues/7",
    "gitlab",
    "gitlab.acme.test",
    "group/sub/web",
    "7",
  ],
] as const)("reads %s as an issue on its host", (url, kind, host, scope, key) => {
  const parsed = sourceControlDefinitions.parseIssueUrl(url);
  expect(parsed?.definition.kind).toBe(kind);
  expect(parsed?.link).toEqual({ host, scope, key });
});

it.each([
  "https://github.com/acme/web/pull/42",
  "https://codeberg.org/acme/web/issues/3",
  "https://dev.azure.com/acme/Web%20App/_workitems/edit/9",
  "https://example.test/acme/web/issues/42",
  "https://github.com/acme/web/issues/0",
])("does not read %s as an issue", (url) => {
  expect(sourceControlDefinitions.parseIssueUrl(url)).toBeNull();
});

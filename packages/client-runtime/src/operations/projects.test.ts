import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, WorkspaceRootId } from "@t3tools/contracts";

import {
  findExistingAddProject,
  getCloneDirectoryName,
  getDefaultCloneUrl,
  getProjectFolderImportLocations,
  githubIncompleteOwnerRepositoryMessage,
  normalizePastedCloneUrl,
  selectProjectFolders,
} from "./projects.ts";
import type { EnvironmentProject } from "../state/models.ts";

describe("add project shared logic", () => {
  it("finds distinct sibling directories across group repositories and environments", () => {
    const environmentId = EnvironmentId.make("local");
    const remoteId = EnvironmentId.make("remote");
    const project = {
      environmentId,
      title: "repo",
      workspaceRoot: "/work/repo",
    };
    const roots = [
      ["frontend", "/work/frontend"],
      ["backend", "/services/backend"],
    ].map(([alias, sourcePath]) => ({
      id: WorkspaceRootId.make(alias!),
      alias: alias!,
      sourcePath: sourcePath!,
      description: "",
      defaultSelected: true,
      accessIntent: "write" as const,
    }));
    expect(
      getProjectFolderImportLocations([
        project,
        { ...project, workspaceRoot: "/work/another" },
        { ...project, workspaceConfig: { version: 1, primaryRootId: roots[0]!.id, roots } },
        { ...project, environmentId: remoteId },
        { ...project, title: "windows", workspaceRoot: "C:\\repos\\project" },
        { ...project, workspaceRoot: "/" },
        { ...project, workspaceRoot: "/scratch/note", isScratch: true },
      ]),
    ).toEqual([
      { environmentId, parentPath: "/work/", title: "repo" },
      { environmentId, parentPath: "/services/", title: "backend" },
      { environmentId: remoteId, parentPath: "/work/", title: "repo" },
      { environmentId, parentPath: "C:\\repos\\", title: "windows" },
    ]);
  });
  it("bulk-selects distinct new folders while allowing explicit repository duplicates", () => {
    const candidate = {
      path: "/repo",
      workspaceRoot: "/repo",
      title: "repo",
      repositoryKey: "host/team/repo",
      existingProjectId: null,
      matchingRepositoryProjectId: null,
      error: null,
      allowSameRepository: false,
    };
    const alias = { ...candidate, path: "/alias" };
    const checkout = { ...candidate, path: "/checkout", workspaceRoot: "/checkout" };
    const existing = {
      ...candidate,
      path: "/existing",
      workspaceRoot: "/existing",
      existingProjectId: ProjectId.make("existing"),
    };
    const sameRepository = { ...checkout, matchingRepositoryProjectId: ProjectId.make("existing") };
    const unavailable = { ...candidate, error: "Unavailable" };
    expect(selectProjectFolders([], [candidate, alias, checkout, existing, unavailable])).toEqual([
      candidate,
    ]);
    expect(selectProjectFolders([], [sameRepository])).toEqual([]);
    expect(selectProjectFolders([candidate], [sameRepository], true)).toEqual([
      candidate,
      { ...sameRepository, allowSameRepository: true },
    ]);
    expect(selectProjectFolders([candidate], [alias], true)).toEqual([candidate]);
  });
  it("asks for a repository name when GitHub input is only an owner path", () => {
    const github = SourceControlProviderKind.make("github");
    expect(githubIncompleteOwnerRepositoryMessage(github, "pingdotgg/")).toBe(
      "Enter the full owner/repository name.",
    );
    expect(githubIncompleteOwnerRepositoryMessage(github, "  pingdotgg//  ")).toBe(
      "Enter the full owner/repository name.",
    );
    expect(githubIncompleteOwnerRepositoryMessage(github, "mona-cat_octo/")).toBe(
      "Enter the full owner/repository name.",
    );

    for (const input of [
      "pingdotgg/t3code",
      "mona-cat_octo/repo",
      "pingdotgg",
      "https://github.com/pingdotgg/t3code.git",
      "git@github.com:pingdotgg/t3code.git",
    ]) {
      expect(githubIncompleteOwnerRepositoryMessage(github, input)).toBeNull();
    }
    expect(
      githubIncompleteOwnerRepositoryMessage(SourceControlProviderKind.make("gitlab"), "group/"),
    ).toBeNull();
    expect(githubIncompleteOwnerRepositoryMessage("url", "owner/")).toBeNull();
    expect(
      githubIncompleteOwnerRepositoryMessage(SourceControlProviderKind.make("forgejo"), "owner/"),
    ).toBeNull();
  });
  it("routes owner/repository shorthand to GitHub over HTTPS", () => {
    expect(normalizePastedCloneUrl("imputnet/helium")).toBe(
      "https://github.com/imputnet/helium.git",
    );
    expect(normalizePastedCloneUrl("  pingdotgg/t3code  ")).toBe(
      "https://github.com/pingdotgg/t3code.git",
    );
  });

  it("keeps explicit clone URLs and local paths unchanged", () => {
    expect(normalizePastedCloneUrl("https://gitlab.com/group/project.git")).toBe(
      "https://gitlab.com/group/project.git",
    );
    expect(normalizePastedCloneUrl("git@github.com:owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
    expect(normalizePastedCloneUrl("group/subgroup/project")).toBe("group/subgroup/project");
    expect(normalizePastedCloneUrl("/srv/git/repo.git")).toBe("/srv/git/repo.git");
  });

  it("uses HTTPS for repositories selected through a provider", () => {
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("github"),
        url: "https://github.com/imputnet/helium",
        sshUrl: "git@github.com:imputnet/helium.git",
      }),
    ).toBe("https://github.com/imputnet/helium");
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("forgejo"),
        url: "https://forgejo.example.test:8443/owner/repo.git",
        sshUrl: "ssh://git@forgejo.example.test:2222/owner/repo.git",
      }),
    ).toBe("https://forgejo.example.test:8443/owner/repo.git");
  });

  it("derives the clone folder name from any pasted clone URL", () => {
    expect(getCloneDirectoryName("https://github.com/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo/")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("ssh://git@github.com:22/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://user@bitbucket.org/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://dev.azure.com/org/project/_git/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo.git?ref=main#readme")).toBe("repo");
    expect(getCloneDirectoryName("/srv/git/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("C:\\src\\repo.git")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:repo.git")).toBe("repo");
    expect(getCloneDirectoryName("  https://github.com/owner/repo.git  ")).toBe("repo");
  });

  it("keeps a numeric repository name that sits on a path", () => {
    expect(getCloneDirectoryName("https://github.com/acme/123.git")).toBe("123");
    expect(getCloneDirectoryName("https://github.com/acme/123")).toBe("123");
    expect(getCloneDirectoryName("git@github.com:acme/123.git")).toBe("123");
  });

  it("finds existing projects by normalized path in the target environment", () => {
    const env = EnvironmentId.make("env");
    const other = EnvironmentId.make("other");
    const projects: EnvironmentProject[] = [
      {
        environmentId: other,
        id: ProjectId.make("same-path-other-env"),
        title: "Other",
        workspaceRoot: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        environmentId: env,
        id: ProjectId.make("project"),
        title: "Repo",
        workspaceRoot: "/repo/",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
    ];

    expect(findExistingAddProject({ projects, environmentId: env, path: "/repo" })?.id).toBe(
      "project",
    );
  });
});

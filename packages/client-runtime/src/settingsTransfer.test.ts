import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  MAX_KEYBINDINGS_COUNT,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  WorkspaceRootId,
  type ServerSettings,
} from "@t3tools/contracts";

import {
  applicationSettingsImportPatch,
  createApplicationSettingsFile,
  createProjectSettingsFile,
  MAX_SETTINGS_FILE_BYTES,
  parseSettingsFile,
  projectSettingsImportPatch,
  projectTransferIdentity,
  projectConfigurationsForImport,
  serializeSettingsFile,
  settingsKeybindingsForExport,
  settingsKeybindingsToImport,
  type TransferProject,
} from "./settingsTransfer.ts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";

const project = (remote = "git@github.com:Team/Repo.git", directory = ""): TransferProject => ({
  id: ProjectId.make("project-1"),
  environmentId: EnvironmentId.make("environment-1"),
  title: "Example",
  workspaceRoot: `/checkout${directory ? `/${directory}` : ""}`,
  repositoryIdentity: {
    canonicalKey: "github.com/team/repo",
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: remote },
    rootPath: "/checkout",
  },
});

const settings = (): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [ProviderInstanceId.make("codex")]: {
      driver: ProviderDriverKind.make("codex"),
      config: { secret: "must-not-export" },
      environment: [{ name: "TOKEN", value: "must-not-export", sensitive: true }],
    },
  },
});

describe("projectTransferIdentity", () => {
  it.each([
    "https://github.com/team/repo.git",
    "ssh://git@github.com:22/TEAM/REPO.git",
    "https://user:password@github.com/Team/Repo.git?token=private",
  ])("identifies equivalent GitHub remotes without credentials (%s)", (remote) => {
    expect(projectTransferIdentity(project(remote))).toEqual(projectTransferIdentity(project()));
    expect(projectTransferIdentity(project(remote)).id).not.toContain("password");
  });

  it("keeps identity across checkout moves and separates forks, subdirectories, ports and case-sensitive hosts", () => {
    const source = project();
    expect(
      projectTransferIdentity({
        ...source,
        id: ProjectId.make("other"),
        environmentId: EnvironmentId.make("other"),
        workspaceRoot: "/worktree",
        repositoryIdentity: { ...source.repositoryIdentity!, rootPath: "/worktree" },
      }),
    ).toEqual(projectTransferIdentity(source));
    const variants = [
      project(),
      project("https://github.com/fork/repo.git"),
      project(undefined, "apps/web"),
      project("ssh://git@github.com:2222/team/repo.git"),
      project("https://example.com/Team/Repo.git"),
      project("https://example.com/team/repo.git"),
      project("ssh://alice@example.com/team/repo.git"),
    ];
    expect(new Set(variants.map((entry) => projectTransferIdentity(entry).id)).size).toBe(
      variants.length,
    );
    const upstream = project("https://github.com/upstream/repo.git");
    expect(
      projectTransferIdentity({
        ...upstream,
        repositoryIdentity: {
          ...upstream.repositoryIdentity!,
          origin: {
            canonicalKey: "github.com/fork/repo",
            remoteUrl: "git@github.com:fork/repo.git",
          },
        },
      }),
    ).toEqual(projectTransferIdentity(project("https://github.com/fork/repo.git")));
  });

  it("uses environment-local identity rather than guessing for unknown Git metadata", () => {
    const local = { ...project(), repositoryIdentity: null };
    expect(projectTransferIdentity(local).kind).toBe("local");
    expect(
      projectTransferIdentity({ ...local, environmentId: EnvironmentId.make("other") }).id,
    ).not.toBe(projectTransferIdentity(local).id);
    expect(projectTransferIdentity(project("file:///repo")).kind).toBe("local");
    expect(
      projectTransferIdentity({
        ...project(),
        repositoryIdentity: {
          ...project().repositoryIdentity!,
          rootPath: "/other",
        },
      }).kind,
    ).toBe("local");
  });
});

describe("settings transfer", () => {
  it("keeps multi-repository groups and incomplete origin metadata environment-local", () => {
    const source = project();
    expect(
      projectTransferIdentity({
        ...source,
        repositoryIdentity: {
          ...source.repositoryIdentity!,
          origin: { canonicalKey: "fork/repository" },
        },
      }).kind,
    ).toBe("local");
    const root = WorkspaceRootId.make("primary");
    const group = {
      ...source,
      workspaceConfig: {
        version: 1,
        primaryRootId: root,
        roots: [
          {
            id: root,
            alias: "main",
            sourcePath: "/main",
            description: "",
            defaultSelected: true,
            accessIntent: "write" as const,
          },
          {
            id: WorkspaceRootId.make("secondary"),
            alias: "api",
            sourcePath: "/api",
            description: "",
            defaultSelected: true,
            accessIntent: "write" as const,
          },
        ],
      },
    };
    expect(projectTransferIdentity(group).kind).toBe("local");
    expect(projectTransferIdentity({ ...group, id: ProjectId.make("other-group") }).id).not.toBe(
      projectTransferIdentity(group).id,
    );
  });
  it("preserves shortcut modifiers and nested conditions and rejects invalid shortcuts before writing", () => {
    const resolved = compileResolvedKeybindingsConfig([
      {
        key: "mod+shift+space",
        command: "terminal.toggle",
        when: "terminalFocus && !(inputFocus || composing)",
      },
      { key: "ctrl++", command: "preview.zoomIn" },
    ]);
    const rules = settingsKeybindingsForExport(resolved);
    expect(compileResolvedKeybindingsConfig(rules)).toEqual(resolved);
    expect(settingsKeybindingsToImport(rules, resolved)).toEqual([]);
    expect(settingsKeybindingsToImport([...rules, ...rules], [])).toEqual(rules);
    expect(() =>
      settingsKeybindingsToImport(
        rules,
        compileResolvedKeybindingsConfig(
          Array.from({ length: MAX_KEYBINDINGS_COUNT }, (_, index) => ({
            key: `ctrl+${index}`,
            command: "terminal.toggle",
          })),
        ),
      ),
    ).toThrow("too large");
    const file = createApplicationSettingsFile({
      clientSettings: DEFAULT_CLIENT_SETTINGS,
      server: settings(),
      keybindings: rules,
    });
    expect(parseSettingsFile(serializeSettingsFile(file))).toEqual(file);
    expect(() =>
      parseSettingsFile(
        JSON.stringify({
          ...file,
          keybindings: [{ key: "ctrl+one+two", command: "terminal.toggle" }],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseSettingsFile(
        JSON.stringify({
          ...file,
          keybindings: [{ key: "mod+j", command: "terminal.toggle", when: "(" }],
        }),
      ),
    ).toThrow();
  });
  it("round-trips only portable application preferences and rejects unsafe fields", () => {
    const source = settings();
    const file = createApplicationSettingsFile({
      clientSettings: {
        ...DEFAULT_CLIENT_SETTINGS,
        uiLanguage: "zh-CN",
        sidebarProjectGroupingOverrides: { privatePath: "separate" },
      },
      server: { ...source, worktreesDirectory: "/private/path" },
      keybindings: [
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+r", command: "script.dev.run" },
      ],
    });
    const contents = serializeSettingsFile(file);
    const parsed = parseSettingsFile(contents);
    expect(parsed).toEqual(file);
    expect(contents).not.toContain("must-not-export");
    expect(contents).not.toContain("/private/path");
    expect(contents).not.toContain("privatePath");
    expect(file.clientSettings.uiLanguage).toBe("zh-CN");
    expect(file.keybindings).toEqual([{ key: "mod+j", command: "terminal.toggle" }]);
    expect(applicationSettingsImportPatch(file, source)).toEqual(file.server);
    const implicitProviderSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "example-model",
      },
    };
    const implicitProviderFile = createApplicationSettingsFile({
      clientSettings: {},
      server: implicitProviderSettings,
      keybindings: [],
    });
    expect(applicationSettingsImportPatch(implicitProviderFile, implicitProviderSettings)).toEqual(
      implicitProviderFile.server,
    );
    for (const id of ["acpRegistry", "uninstalledDriver"]) {
      const driver = ProviderDriverKind.make(id);
      const instanceId = ProviderInstanceId.make(id);
      const customFile = createApplicationSettingsFile({
        clientSettings: {},
        server: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: { [instanceId]: { driver } },
          defaultModelSelection: { instanceId, model: "example-model" },
        },
        keybindings: [],
      });
      expect(() => applicationSettingsImportPatch(customFile, DEFAULT_SERVER_SETTINGS)).toThrow(
        "same driver",
      );
    }
    const rootId = WorkspaceRootId.make("import-root");
    const configuration = {
      name: "Imported project",
      settings: { branchNamePrefix: "feature" },
      providers: {},
      workspace: {
        primaryRootId: rootId,
        roots: [
          {
            id: rootId,
            alias: "main",
            remoteUrl: "git@github.com:team/repo.git",
            directory: "web",
            description: "Frontend",
            defaultSelected: true,
            accessIntent: "write" as const,
          },
        ],
      },
    };
    const withProjects = parseSettingsFile(
      serializeSettingsFile({ ...file, projects: [configuration] }),
    );
    expect(projectConfigurationsForImport(withProjects)).toEqual([configuration]);
    expect(projectConfigurationsForImport(file)).toEqual([]);
    expect(() =>
      parseSettingsFile(
        JSON.stringify({
          ...file,
          projects: [
            {
              ...configuration,
              workspace: {
                ...configuration.workspace,
                roots: [{ ...configuration.workspace.roots[0], directory: "../../outside" }],
              },
            },
          ],
        }),
      ),
    ).toThrow();
    for (const server of [
      { providerInstances: source.providerInstances },
      { worktreesDirectory: "/unsafe" },
    ]) {
      expect(() => parseSettingsFile(JSON.stringify({ ...file, server }))).toThrow(
        "Invalid settings file",
      );
    }
  });

  it.each([
    "not JSON",
    "null",
    JSON.stringify({ format: "t3-code-settings", version: 2 }),
    " ".repeat(MAX_SETTINGS_FILE_BYTES + 1),
  ])("rejects malformed, unsupported and oversized files", (contents) => {
    expect(() => parseSettingsFile(contents)).toThrow();
  });

  it("restores the project's override set, including null values and inherited settings", () => {
    const sourceProject = project();
    const source = {
      ...settings(),
      projectSettingsFolded: true,
      projectSettingsOverrides: {
        [sourceProject.id]: {
          defaultModelSelection: null,
          branchNamePrefix: "feature",
          defaultProjectScripts: [],
        },
      },
    };
    const file = createProjectSettingsFile(sourceProject, source);
    expect(parseSettingsFile(serializeSettingsFile(file))).toEqual(file);
    const destination = { ...sourceProject, id: ProjectId.make("target-project") };
    expect(
      projectSettingsImportPatch(file, destination, {
        ...settings(),
        projectSettingsOverrides: { [destination.id]: { defaultAutoPull: true } },
      }),
    ).toEqual({
      projectSettingsOverrides: {
        [destination.id]: {
          defaultModelSelection: null,
          branchNamePrefix: "feature",
          defaultProjectScripts: [],
        },
      },
    });
    expect(file.settings).not.toHaveProperty("defaultRuntimeMode");
    expect(projectSettingsImportPatch({ ...file, settings: {} }, destination, source)).toEqual({
      projectSettingsOverrides: { [destination.id]: null },
    });
    expect(() =>
      parseSettingsFile(JSON.stringify({ ...file, settings: { defaultRuntimeMode: "invalid" } })),
    ).toThrow();
  });

  it("remaps action repositories by alias and rejects missing repositories and incompatible providers", () => {
    const root = WorkspaceRootId.make("root-source");
    const targetRoot = WorkspaceRootId.make("root-target");
    const workspace = {
      primaryRootId: root,
      version: 1,
      roots: [
        {
          id: root,
          alias: "web",
          sourcePath: "/source",
          description: "",
          defaultSelected: true,
          accessIntent: "write" as const,
        },
      ],
    };
    const sourceProject = { ...project(), workspaceConfig: workspace };
    const file = createProjectSettingsFile(sourceProject, {
      ...settings(),
      projectSettingsOverrides: {
        [sourceProject.id]: {
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "example-model",
          },
          defaultProjectScripts: [
            {
              id: "dev",
              name: "Dev",
              command: "vp run dev",
              icon: "play",
              runOnWorktreeCreate: false,
              repositoryRootIds: [root],
            },
          ],
        },
      },
    });
    const destination = {
      ...sourceProject,
      workspaceConfig: {
        ...workspace,
        primaryRootId: targetRoot,
        roots: [{ ...workspace.roots[0]!, id: targetRoot }],
      },
    };
    const patch = projectSettingsImportPatch(file, destination, settings());
    expect(
      patch.projectSettingsOverrides?.[destination.id]?.defaultProjectScripts?.[0]
        ?.repositoryRootIds,
    ).toEqual([targetRoot]);
    expect(() => projectSettingsImportPatch(file, project(), settings())).toThrow(
      "requires repository",
    );
    expect(() =>
      projectSettingsImportPatch(file, destination, {
        ...settings(),
        providerInstances: {
          [ProviderInstanceId.make("codex")]: { driver: ProviderDriverKind.make("claudeAgent") },
        },
      }),
    ).toThrow("same driver");
  });
});

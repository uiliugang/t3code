import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  MAX_KEYBINDINGS_COUNT,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SourceControlProviderKind,
  WorkspaceRootId,
  type ServerSettings,
  requiredScopesForServerSettingsPatch,
  AuthSettingsWriteScope,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Struct from "effect/Struct";

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
import {
  applyServerSettingsPatch,
  loadVirtualGeneratorCatalog,
} from "@t3tools/shared/serverSettings";
import {
  migrateVirtualModels,
  resolveVirtualModel,
  virtualModelReference,
} from "@t3tools/shared/virtualModels";

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
  it("restores stable virtual references without requiring their source provider or replacing local bindings", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("office"),
      model: "small",
      options: [{ id: "effort", value: "high" }],
    };
    const ref = virtualModelReference("team");
    const source = {
      ...migrateVirtualModels(settings()),
      defaultModelSelection: ref,
      virtualModels: { team: { name: "Team", binding: selection } },
    };
    const file = parseSettingsFile(
      serializeSettingsFile(
        createApplicationSettingsFile({ server: source, clientSettings: {}, keybindings: [] }),
      ),
    );
    if (file.scope !== "application") throw new Error("Expected application settings");
    for (const change of [
      null,
      "unbind",
      { expected: { binding: null }, save: { binding: selection } },
    ]) {
      expect(() =>
        parseSettingsFile(
          JSON.stringify({
            ...file,
            server: { ...file.server, virtualModels: { team: change } },
          }),
        ),
      ).toThrow();
    }
    const target = migrateVirtualModels(settings());
    const restored = applyServerSettingsPatch(target, applicationSettingsImportPatch(file, target));
    expect(
      applyServerSettingsPatch(target, {
        textGenerationModelSelection: { virtualModelId: "team" },
      }).textGenerationModelSelection,
    ).toEqual(ref);
    expect(restored.virtualModels?.team).toEqual({ name: "Team", binding: null });
    expect(resolveVirtualModel(restored, restored.defaultModelSelection)).toEqual(ref);
    const local = { ...selection, instanceId: ProviderInstanceId.make("local") };
    const rebound = applyServerSettingsPatch(restored, {
      virtualModels: { team: { binding: local } },
    });
    const again = applyServerSettingsPatch(rebound, applicationSettingsImportPatch(file, rebound));
    expect(resolveVirtualModel(again, again.defaultModelSelection)).toEqual(local);
    const preparedBeforeBinding = applicationSettingsImportPatch(file, target);
    const concurrent = applyServerSettingsPatch(rebound, preparedBeforeBinding);
    expect(resolveVirtualModel(concurrent, concurrent.defaultModelSelection)).toEqual(local);
  });
  it("rejects virtual settings before writing to an environment without virtual model support", () => {
    const legacy = settings();
    const file = createApplicationSettingsFile({
      server: migrateVirtualModels(legacy),
      clientSettings: {},
      keybindings: [],
    });
    expect(() => applicationSettingsImportPatch(file, legacy)).toThrow(/virtual models/i);
  });
  it.effect("restores a discovered generator model only when its destination lists it", () =>
    Effect.gen(function* () {
      const id = ProviderInstanceId.make("text-api");
      const target = {
        ...migrateVirtualModels(settings()),
        textGenerators: {
          [id]: {
            kind: "openaiCompatible" as const,
            enabled: true,
            apiKey: "",
            baseUrl: "https://example.test",
          },
        },
      };
      const binding = { instanceId: id, model: "discovered" };
      const virtualModels = {
        team: { binding },
        missing: { binding: { ...binding, model: "gone" } },
      };
      const file = parseSettingsFile(
        serializeSettingsFile(
          createApplicationSettingsFile({
            server: { ...target, virtualModels },
            clientSettings: {},
            keybindings: [],
          }),
        ),
      );
      if (file.scope !== "application") throw new Error("Expected application settings");
      const catalog = yield* loadVirtualGeneratorCatalog(virtualModels, target, () =>
        Effect.succeed({ models: [{ id: "discovered", name: "Discovered" }] }),
      );
      const imported = applicationSettingsImportPatch(file, target, undefined, [], catalog);
      expect(imported.importVirtualModels).toEqual({
        team: { binding },
        missing: { binding: null },
      });
    }),
  );
  it("imports optional model edits only for a matching virtual binding provider", () => {
    const target = migrateVirtualModels(settings());
    const office = ProviderInstanceId.make("office");
    const physical = { instanceId: office, model: "small" };
    const file = createApplicationSettingsFile({
      server: {
        ...target,
        defaultModelSelection: virtualModelReference("team"),
        virtualModels: { team: { binding: physical } },
        favorites: [{ provider: office, model: "small" }],
        providerModelPreferences: { [office]: { hiddenModels: [], modelOrder: ["small"] } },
        providerInstances: {
          [office]: {
            driver: ProviderDriverKind.make("codex"),
            config: { customModels: ["small"] },
          },
        },
      },
      clientSettings: {},
      keybindings: [],
    });
    const restored = applyServerSettingsPatch(
      target,
      applicationSettingsImportPatch(file, target, undefined, []),
    );
    expect(restored.virtualModels?.team?.binding).toBeNull();
    expect(restored.providerInstances[office]).toBeUndefined();
    expect(restored.favorites).toEqual([]);
    expect(restored.providerModelPreferences?.[office]).toBeUndefined();
    const configured = {
      ...target,
      providerInstances: { [office]: { driver: ProviderDriverKind.make("codex") } },
    };
    const bound = applyServerSettingsPatch(
      configured,
      applicationSettingsImportPatch(file, configured, undefined, []),
    );
    expect(bound.virtualModels?.team?.binding).toEqual(physical);
    expect(() =>
      applicationSettingsImportPatch(
        { ...file, server: { ...file.server, fallbackModelSelection: physical } },
        target,
      ),
    ).toThrow("same driver");
  });
  it("transfers model edits while preserving destination provider credentials and installation settings", () => {
    const codex = ProviderInstanceId.make("codex");
    const claude = ProviderInstanceId.make("claudeAgent");
    const models = [
      { slug: "built-in-model", name: "Renamed model", capabilities: { optionDescriptors: [] } },
    ];
    const source = settings();
    const file = createApplicationSettingsFile({
      clientSettings: {},
      server: {
        ...source,
        providerInstances: {
          ...source.providerInstances,
          [codex]: {
            driver: ProviderDriverKind.make("codex"),
            config: {
              customModels: models,
              binaryPath: "/private/codex",
              apiKey: "source-secret",
              launchArgs: "--token source-secret",
            },
          },
        },
      },
      keybindings: [],
    });
    const contents = serializeSettingsFile(file);
    expect(contents).toContain("Renamed model");
    expect(contents).not.toContain("source-secret");
    expect(contents).not.toContain("/private/codex");
    const restored = parseSettingsFile(contents);
    if (restored.scope !== "application") throw new Error("Expected application settings");
    const destinationCodex = {
      driver: ProviderDriverKind.make("codex"),
      environment: [{ name: "TOKEN", value: "destination-secret", sensitive: true }],
      config: {
        binaryPath: "/destination/codex",
        launchArgs: "--destination",
        customModels: ["old-model"],
      },
    };
    const target = {
      ...source,
      providerInstances: {
        [codex]: destinationCodex,
        [claude]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: "/destination/claude" },
        },
      },
    };
    const patch = applicationSettingsImportPatch(restored, target);
    expect(patch.providerInstances).toEqual({
      ...target.providerInstances,
      [codex]: {
        ...destinationCodex,
        config: { ...destinationCodex.config, customModels: models },
      },
    });
    expect(
      applicationSettingsImportPatch(restored, { ...target, providerInstances: {} })
        .providerInstances?.[codex],
    ).toEqual({
      driver: "codex",
      config: { customModels: models },
    });
    expect(() =>
      applicationSettingsImportPatch(restored, {
        ...target,
        providerInstances: { [codex]: { driver: ProviderDriverKind.make("claudeAgent") } },
      }),
    ).toThrow("same driver");
    expect(() =>
      applicationSettingsImportPatch(restored, {
        ...target,
        providerInstances: {
          ...target.providerInstances,
          [codex]: { driver: ProviderDriverKind.make("codex"), config: "opaque" },
        },
      }),
    ).toThrow("Repair provider");
    const cleared = { ...restored, providerModels: { [codex]: [] } };
    expect(
      applicationSettingsImportPatch(cleared, target).providerInstances?.[codex]?.config,
    ).toMatchObject({ customModels: [], binaryPath: "/destination/codex" });
    const legacy = { ...restored };
    delete legacy.providerModels;
    expect(applicationSettingsImportPatch(legacy, target)).toEqual(
      Struct.omit(restored.server, ["requireConnectDeviceApproval"]),
    );
    const custom = ProviderInstanceId.make("custom-codex");
    const customFile = createApplicationSettingsFile({
      clientSettings: {},
      server: {
        ...source,
        providerInstances: {
          [custom]: { driver: ProviderDriverKind.make("codex"), config: { customModels: models } },
        },
      },
      keybindings: [],
    });
    expect(customFile.providers[custom]).toBe("codex");
    expect(() => applicationSettingsImportPatch(customFile, target)).toThrow("custom-codex");
  });
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
        voiceMicrophone: "private-device-microphone-id",
        diffColorScheme: "custom",
        diffCustomColors: {
          addition: "#15803d",
          deletion: "#b91c1c",
          modified: "#1d4ed8",
          conflict: "#a16207",
        },
        sidebarProjectGroupingOverrides: { privatePath: "separate" },
      },
      server: {
        ...source,
        requireConnectDeviceApproval: true,
        enablePreviewTunnel: false,
        defaultTheme: "private-theme",
        defaultThemeSetAt: "2026-11-14T00:00:00.000Z",
        defaultAppearance: "dark",
        defaultAppearanceSetAt: "2026-11-14T00:00:00.000Z",
        worktreesDirectory: "/private/path",
        cloudSpeechCredentials: { ...source.cloudSpeechCredentials, openai: "must-not-export" },
        daxiang: { ...source.daxiang, clientId: "fixture", clientSecret: "must-not-export" },
        textGenerators: {
          [ProviderInstanceId.make("generator")]: {
            kind: "openaiCompatible",
            baseUrl: "https://models.example/v1",
            apiKey: "must-not-export",
            enabled: true,
          },
        },
      },
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
    expect(contents).not.toContain("private-device-microphone-id");
    expect(file.clientSettings).not.toHaveProperty("voiceMicrophone");
    expect(file.server).not.toHaveProperty("enablePreviewTunnel");
    const legacyMicrophone = parseSettingsFile(
      JSON.stringify({
        ...JSON.parse(contents),
        clientSettings: { ...file.clientSettings, voiceMicrophone: "old-device-id" },
      }),
    );
    expect(legacyMicrophone.scope).toBe("application");
    expect(legacyMicrophone).not.toHaveProperty("clientSettings.voiceMicrophone");
    expect(file.clientSettings.uiLanguage).toBe("zh-CN");
    expect(file.clientSettings.diffColorScheme).toBe("custom");
    expect(file.clientSettings.diffCustomColors?.conflict).toBe("#a16207");
    expect(file.keybindings).toEqual([{ key: "mod+j", command: "terminal.toggle" }]);
    expect(applicationSettingsImportPatch(file, source)).toEqual(file.server);
    expect(applicationSettingsImportPatch(file, source).requireConnectDeviceApproval).toBe(true);
    const sameApprovalTarget = { ...source, requireConnectDeviceApproval: true };
    expect(applicationSettingsImportPatch(file, sameApprovalTarget)).toEqual(
      Struct.omit(file.server, ["requireConnectDeviceApproval"]),
    );
    expect(applicationSettingsImportPatch(file, sameApprovalTarget)).not.toHaveProperty(
      "requireConnectDeviceApproval",
    );
    expect(
      requiredScopesForServerSettingsPatch(
        applicationSettingsImportPatch(file, sameApprovalTarget),
      ),
    ).toEqual([AuthSettingsWriteScope]);
    expect(contents).not.toContain("private-theme");
    expect(contents).not.toContain("defaultAppearance");
    const updatedPreferences = {
      fallbackModelSelection: {
        instanceId: ProviderInstanceId.make("fallback-codex"),
        model: "fallback-model",
      },
      idleCompaction: "beforeCacheExpires" as const,
      compactIdleThreads: true,
      remoteBranchDisplayDays: 45,
      hideMergedRemoteBranches: false,
      autoDeleteMergedBranches: true,
      worktreeSharedDependencies: false,
      speechModelId: "fixture-model",
      speechModelUnloadTimeout: "min_5" as const,
      speechProjectCustomWords: [{ term: "T3", aliases: ["tee three"] }],
      speechPostProcessingModelSelection: {
        instanceId: ProviderInstanceId.make("speech-cleanup"),
        model: "cleanup-model",
      },
      hiddenThreadTags: ["hidden"],
      hideTaggedThreads: true,
      promptSuggestionsEnabled: true,
      fastWorktreeCheckout: true,
      keepAwakeWhileAgentsWork: false,
      ghqCloneLayout: true,
      storageCleanup: { ...source.storageCleanup, browserArtifactsAfterDays: 21 },
      worktreeCleanup: { mode: "off" as const },
      backgroundActivity: { ...source.backgroundActivity, profile: "battery-saver" as const },
      automaticGitFetchInterval: Duration.minutes(10),
      providerHealthRefreshInterval: Duration.minutes(3),
    };
    const updatedSource: ServerSettings = {
      ...source,
      providerInstances: {
        ...source.providerInstances,
        [ProviderInstanceId.make("fallback-codex")]: {
          driver: ProviderDriverKind.make("codex"),
        },
        [ProviderInstanceId.make("speech-cleanup")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
        },
      },
    };
    const updated = createApplicationSettingsFile({
      clientSettings: {},
      server: { ...updatedSource, ...updatedPreferences },
      keybindings: [],
    });
    const restored = parseSettingsFile(serializeSettingsFile(updated));
    expect(restored.scope).toBe("application");
    if (restored.scope !== "application") throw new Error("Expected application settings");
    expect(applicationSettingsImportPatch(restored, updatedSource)).toMatchObject(
      updatedPreferences,
    );
    expect(updated.providers[ProviderInstanceId.make("fallback-codex")]).toBe("codex");
    expect(updated.providers[ProviderInstanceId.make("speech-cleanup")]).toBe("claudeAgent");
    const withoutSpeech = Object.fromEntries(
      Object.entries(updatedSource.providerInstances).filter(([id]) => id !== "speech-cleanup"),
    );
    expect(() =>
      applicationSettingsImportPatch(restored, {
        ...updatedSource,
        providerInstances: withoutSpeech,
      }),
    ).toThrow("speech-cleanup");
    expect(JSON.parse(serializeSettingsFile(updated)).server.automaticGitFetchInterval).toBe(
      600_000,
    );
    expect(() => applicationSettingsImportPatch(restored, source)).toThrow("fallback-codex");
    const legacyFile = { ...file, server: { defaultAutoPull: false } };
    const legacy = parseSettingsFile(serializeSettingsFile(legacyFile));
    expect(
      legacy.scope === "application" && applicationSettingsImportPatch(legacy, source),
    ).toEqual(legacyFile.server);
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
      Struct.omit(implicitProviderFile.server, ["requireConnectDeviceApproval"]),
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
    const sourceProject = {
      ...project(),
      repositoryIdentity: {
        ...project().repositoryIdentity!,
        provider: SourceControlProviderKind.make("github"),
      },
    };
    const issueSources = [{ provider: "github" as const, host: "github.com", scope: "team/repo" }];
    const legacySources = [
      { provider: "meituan" as const, host: "mep.sankuai.com", scope: "42" },
      ...issueSources,
    ];
    const source = {
      ...settings(),
      issueProjectSources: {
        [sourceProject.id]: legacySources,
      },
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
    expect(file).toHaveProperty("issueSources", issueSources);
    expect(parseSettingsFile(serializeSettingsFile(file))).toEqual(file);
    const destination = { ...sourceProject, id: ProjectId.make("target-project") };
    const unrelatedId = ProjectId.make("unrelated-project");
    const target = {
      ...settings(),
      issueProjectSources: {
        [destination.id]: [{ provider: "github" as const, host: "github.com", scope: "old/repo" }],
        [unrelatedId]: issueSources,
      },
      projectSettingsOverrides: { [destination.id]: { defaultAutoPull: true } },
    };
    const patch = projectSettingsImportPatch(file, destination, target);
    expect(
      projectSettingsImportPatch({ ...file, issueSources: legacySources }, destination, target),
    ).toEqual(patch);
    const incompatible = projectSettingsImportPatch(
      { ...file, issueSources: legacySources.slice(0, 1) },
      destination,
      target,
    );
    expect(incompatible.projectSettingsOverrides).toEqual(patch.projectSettingsOverrides);
    expect(incompatible).not.toHaveProperty("issueProjectSources");
    expect(patch.projectSettingsOverrides).toEqual({
      [destination.id]: {
        defaultModelSelection: null,
        branchNamePrefix: "feature",
        defaultProjectScripts: [],
      },
    });
    expect(applyServerSettingsPatch(target, patch).issueProjectSources).toEqual({
      ...target.issueProjectSources,
      [destination.id]: issueSources,
    });
    const updatedSources = [{ provider: "github" as const, host: "github.com", scope: "new/repo" }];
    const latestTarget = {
      ...target,
      issueProjectSources: { ...target.issueProjectSources, [unrelatedId]: updatedSources },
    };
    expect(applyServerSettingsPatch(latestTarget, patch).issueProjectSources).toEqual({
      ...latestTarget.issueProjectSources,
      [destination.id]: issueSources,
    });
    expect(file.settings).not.toHaveProperty("defaultRuntimeMode");
    expect(
      projectSettingsImportPatch(
        { ...Struct.omit(file, ["issueSources"]), settings: {} },
        destination,
        source,
      ),
    ).toEqual({ projectSettingsOverrides: { [destination.id]: null } });
    expect(
      applyServerSettingsPatch(
        target,
        projectSettingsImportPatch({ ...file, issueSources: [] }, destination, target),
      ).issueProjectSources,
    ).toEqual({ ...target.issueProjectSources, [destination.id]: [] });
    expect(createProjectSettingsFile(sourceProject, settings())).not.toHaveProperty("issueSources");
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

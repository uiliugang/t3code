import {
  ClientSettingsPatch,
  ClientServerSettingsPatch,
  CustomModelSetting,
  KeybindingsConfig,
  IssueSource,
  projectIssueSourcesForTransfer,
  importProjectIssueSources,
  MAX_KEYBINDINGS_COUNT,
  ProjectSettingsOverrides,
  ProjectTransferWorkspace,
  ProjectImportDefinition,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
  VirtualModels,
  type ServerProvider,
  globalIdleCompaction,
  TrimmedNonEmptyString,
  WorkspaceRootId,
  type ClientSettings,
  type EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  type ListTextGeneratorModelsResult,
  type Project,
  type ResolvedKeybindingsConfig,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
} from "@t3tools/contracts";
import { canonicalRepositoryCloneKey } from "@t3tools/shared/git";
import {
  bindingProviders,
  projectVirtualModels,
  virtualModelRoles,
} from "@t3tools/shared/virtualModels";
import {
  configuredTransferDriver,
  importVirtualBindings,
  loadVirtualGeneratorCatalog,
} from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import type { AtomRegistry } from "effect/reactivity";
import type { AtomCommand } from "./state/runtime.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { compileResolvedKeybindingRule } from "@t3tools/shared/keybindings";
import { translateUi, type UiTranslator } from "@t3tools/shared/uiLocale";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { getProviderClient } from "./providerClients.ts";

export const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;

// Older backups include voiceMicrophone; its device-local ID is discarded on read and write.
const ApplicationClientSettings = Schema.Struct(
  Struct.omit(ClientSettingsPatch.fields, [
    "onboardingCompletedAt",
    "browserProfiles",
    "browserDefaultProfileId",
    "sidebarProjectGroupingOverrides",
    "pullRequestMergeMethodOverrides",
    "loadBalancingWeights",
  ]),
);

const applicationServerSettingsTransferPolicy = {
  setModelFavorites: "local",
  setModelsHidden: "local",
  setProviderModelOrder: "local",
  favorites: "portable",
  providerModelPreferences: "portable",
  migrateModelPreferences: "local",
  worktreeCleanup: "portable",
  storageCleanup: "portable",
  worktreesDirectory: "local",
  fastWorktreeCheckout: "portable",
  responseStreamingMode: "portable",
  enableProviderUpdateChecks: "portable",
  continueThreadsAfterServerUpdate: "portable",
  keepAwakeWhileAgentsWork: "portable",
  requireConnectDeviceApproval: "portable",
  enableAgentBrowserAccess: "portable",
  cloudSpeechCredentials: "local",
  speechModelId: "portable",
  speechAcceleration: "local",
  speechModelUnloadTimeout: "portable",
  speechProjectCustomWords: "portable",
  speechPostProcessingModelSelection: "portable",
  projectAgentBrowserAccessOverrides: "local",
  defaultAutoPull: "portable",
  defaultProjectScripts: "portable",
  projectScriptOverrides: "local",
  projectAutoPullOverrides: "local",
  defaultModelSelection: "portable",
  defaultRuntimeMode: "portable",
  fallbackModelSelection: "portable",
  projectSettingsOverrides: "local",
  enableAgentDeviceAccess: "portable",
  enableDeviceSupport: "portable",
  deviceOnboardingCompleted: "local",
  deviceHosts: "local",
  easDeviceHosts: "local",
  simlockDeviceHosts: "local",
  simlockDeviceHostsEnabled: "portable",
  sidebarAutoSettleAfterDays: "portable",
  compactIdleThreads: "portable",
  idleCompaction: "portable",
  sidebarAutoSettleKeepPullRequests: "portable",
  sidebarAutoSettleOnMerge: "portable",
  autoResumeLimitedThreads: "portable",
  snoozeLimitedThreads: "portable",
  snoozePresets: "portable",
  hiddenThreadTags: "portable",
  hideTaggedThreads: "portable",
  guestSharingEnabled: "portable",
  linkedEnvironmentsEnabled: "portable",
  workflowsEnabled: "local",
  promptSuggestionsEnabled: "portable",
  backgroundActivity: "portable",
  automaticGitFetchInterval: "portable",
  providerHealthRefreshInterval: "portable",
  backgroundActivityProfile: "portable",
  environmentIcon: "local",
  environmentName: "local",
  defaultThreadEnvMode: "portable",
  newWorktreesStartFromOrigin: "portable",
  newWorktreesMainBranchOnly: "portable",
  childWorktreesMainBranchOnly: "portable",
  remoteBranchDisplayDays: "portable",
  hideMergedRemoteBranches: "portable",
  autoDeleteMergedBranches: "portable",
  worktreeSubmodules: "portable",
  worktreeSharedDependencies: "portable",
  addProjectBaseDirectory: "local",
  ghqCloneLayout: "portable",
  textGenerationModelSelection: "portable",
  threadTitleInstructions: "portable",
  branchNamingMode: "portable",
  branchNamePrefix: "portable",
  branchNameInstructions: "portable",
  removeAgentCreditsOnMerge: "portable",
  sourceControlWritingStyle: "portable",
  sourceControlWriterModelSelection: "portable",
  reviewGuidesEnabled: "portable",
  reviewGuideModelSelection: "portable",
  reviewGuideInstructions: "portable",
  pullRequestMergeMethod: "portable",
  observability: "local",
  enablePreviewTunnel: "local",
  sourceControlHosts: "local",
  issueProjectSources: "local",
  workItemDiscoveryEnabled: "portable",
  workItemDiscoveryLimit: "portable",
  daxiang: "local",
  meituanIntegrationEnabled: "local",
  meituanSourceControlEnabled: "local",
  meituanRequirementsEnabled: "local",
  offeredSourceControlProviders: "portable",
  providerInstances: "local",
  usageLimitSources: "local",
  textGenerators: "local",
  virtualModels: "portable",
  importVirtualModels: "local",
  secretProviders: "local",
  usageHistoryRetentionDays: "local",
  usagePriceOverrides: "portable",
  usageModelAliases: "portable",
} satisfies Record<keyof typeof ClientServerSettingsPatch.Type, "portable" | "local">;

type PortableServerSetting = {
  [
    K in keyof typeof applicationServerSettingsTransferPolicy
  ]: (typeof applicationServerSettingsTransferPolicy)[K] extends "portable" ? K : never;
}[keyof typeof applicationServerSettingsTransferPolicy];

const APPLICATION_SERVER_SETTINGS_KEYS = Struct.keys(
  applicationServerSettingsTransferPolicy,
).filter(
  (key): key is PortableServerSetting =>
    applicationServerSettingsTransferPolicy[key] === "portable",
);

const ApplicationServerSettings = Schema.Struct({
  ...Struct.pick(ClientServerSettingsPatch.fields, APPLICATION_SERVER_SETTINGS_KEYS),
  virtualModels: Schema.optionalKey(Schema.toType(VirtualModels)),
});
const encodeApplicationServerSettings = Schema.encodeSync(
  Schema.Struct(Struct.pick(ServerSettings.fields, APPLICATION_SERVER_SETTINGS_KEYS)),
);

const ThemeSelection = Schema.Struct({
  preference: Schema.String,
  mode: Schema.Literals(["light", "dark", "system"]),
  halves: Schema.Struct({
    light: Schema.optionalKey(Schema.String),
    dark: Schema.optionalKey(Schema.String),
  }),
  // Theme files are decoded by each client's existing theme importer before any write.
  customThemes: Schema.Array(Schema.Unknown),
});

const ProjectTransferIdentity = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["git", "local"]),
  repository: Schema.optionalKey(TrimmedNonEmptyString),
  directory: Schema.optionalKey(Schema.String),
});

const commonFields = {
  format: Schema.Literal("t3-code-settings"),
  version: Schema.Literal(1),
  providers: Schema.Record(ProviderInstanceId, ProviderDriverKind),
};
const ProviderModels = Schema.Record(ProviderInstanceId, Schema.Array(CustomModelSetting));
const decodeProviderModels = Schema.decodeUnknownSync(ProviderModels);

const ApplicationSettingsFile = Schema.Struct({
  ...commonFields,
  scope: Schema.Literal("application"),
  clientSettings: ApplicationClientSettings,
  server: ApplicationServerSettings,
  providerModels: Schema.optionalKey(ProviderModels),
  keybindings: KeybindingsConfig,
  theme: Schema.optionalKey(ThemeSelection),
  mobile: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  projects: Schema.optionalKey(
    Schema.Array(ProjectImportDefinition).check(Schema.isMaxLength(1000)),
  ),
});

const ProjectSettingsFile = Schema.Struct({
  ...commonFields,
  scope: Schema.Literal("project"),
  virtualModels: Schema.optionalKey(Schema.toType(VirtualModels)),
  name: TrimmedNonEmptyString,
  identity: ProjectTransferIdentity,
  settings: Schema.toType(ProjectSettingsOverrides),
  repositories: Schema.Record(WorkspaceRootId, TrimmedNonEmptyString),
  issueSources: Schema.optionalKey(Schema.Array(IssueSource)),
  workspace: Schema.optionalKey(ProjectTransferWorkspace),
});

const SettingsFile = Schema.Union([ApplicationSettingsFile, ProjectSettingsFile]);
const decodeSettingsFile = Schema.decodeUnknownSync(SettingsFile);
const encodeSettingsFile = Schema.encodeSync(SettingsFile);
const decodeApplicationClientSettings = Schema.decodeSync(ApplicationClientSettings);
const decodeApplicationServerSettings = Schema.decodeUnknownSync(ApplicationServerSettings);
export type SettingsFile = typeof SettingsFile.Type;
type ApplicationSettingsFile = typeof ApplicationSettingsFile.Type;
type ProjectSettingsFile = typeof ProjectSettingsFile.Type;
export type TransferProject = Pick<
  Project,
  "id" | "title" | "workspaceRoot" | "workspaceConfig" | "repositoryIdentity"
> & { readonly environmentId: EnvironmentId };

export function projectTransferIdentity(project: TransferProject) {
  const identity = project.repositoryIdentity;
  const remote = identity?.origin ? identity.origin.remoteUrl : identity?.locator.remoteUrl;
  const repository = remote ? canonicalRepositoryCloneKey(remote) : null;
  const root = identity?.rootPath?.replaceAll("\\", "/").replace(/\/+$/, "");
  const workspace = project.workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const directory =
    root === workspace
      ? ""
      : root && workspace.startsWith(`${root}/`)
        ? workspace.slice(root.length + 1)
        : null;
  if (
    repository !== null &&
    directory !== null &&
    (project.workspaceConfig?.roots.length ?? 1) === 1
  ) {
    return {
      kind: "git" as const,
      id: `git:v1:${JSON.stringify([repository, directory])}`,
      repository,
      directory,
    };
  }
  // Missing Git metadata and repository groups have no proven cross-machine identity.
  return {
    kind: "local" as const,
    id: `local:v1:${JSON.stringify([project.environmentId, project.id])}`,
    ...(repository ? { repository } : {}),
    ...(directory !== null ? { directory } : {}),
  };
}

function providerReferences(
  settings: ProjectSettingsOverrides | ServerSettingsPatch,
  includePreferences = true,
) {
  return new Set([
    ...[
      settings.defaultModelSelection,
      "fallbackModelSelection" in settings ? settings.fallbackModelSelection : null,
      settings.textGenerationModelSelection,
      "speechPostProcessingModelSelection" in settings
        ? settings.speechPostProcessingModelSelection
        : null,
      settings.sourceControlWriterModelSelection,
      settings.reviewGuideModelSelection,
    ].flatMap((selection) =>
      selection?.instanceId && !selection.virtualModelId ? [selection.instanceId] : [],
    ),
    ...Object.keys(settings.providerInstances ?? {}).map((id) => ProviderInstanceId.make(id)),
    ...(includePreferences && "favorites" in settings
      ? (settings.favorites ?? []).map((entry) => entry.provider)
      : []),
    ...(includePreferences && "providerModelPreferences" in settings
      ? Object.keys(settings.providerModelPreferences ?? {}).map((id) =>
          ProviderInstanceId.make(id),
        )
      : []),
  ]);
}

function providerDrivers(
  settings: ProjectSettingsOverrides | ServerSettingsPatch,
  source: ServerSettings,
  extraProviderIds: ReadonlyArray<ProviderInstanceId> = [],
) {
  return Object.fromEntries(
    [...new Set([...providerReferences(settings), ...extraProviderIds])].map((id) => [
      id,
      configuredTransferDriver(source, id) ?? ProviderDriverKind.make(id),
    ]),
  );
}

export function importGeneratorCatalog<E>(
  file: SettingsFile,
  target: ServerSettings,
  environmentId: EnvironmentId,
  registry: AtomRegistry.AtomRegistry,
  command: AtomCommand<
    { environmentId: EnvironmentId; input: { id: ProviderInstanceId } },
    ListTextGeneratorModelsResult,
    E
  >,
) {
  return Effect.runPromise(
    loadVirtualGeneratorCatalog(
      file.scope === "project" ? file.virtualModels : file.server.virtualModels,
      target,
      (id) => command.run(registry, { environmentId, input: { id } }),
    ),
  );
}

function importedVirtualModels(
  file: SettingsFile,
  target: ServerSettings,
  providers?: readonly ServerProvider[],
  generators?: ReadonlyMap<ProviderInstanceId, readonly string[]>,
) {
  const incoming = file.scope === "project" ? file.virtualModels : file.server.virtualModels;
  return importVirtualBindings(
    incoming,
    target,
    (id) => {
      const client = getProviderClient(id);
      const driver =
        configuredTransferDriver(target, id) ??
        (client?.hasDefaultInstance !== false ? client?.driverKind : undefined);
      return driver !== undefined && driver === file.providers[id];
    },
    providers,
    generators,
  );
}

export function assertVirtualModelsSupported(
  file: SettingsFile,
  target: ServerSettings,
  t: UiTranslator,
) {
  if (target.virtualModels != null) return;
  const usesReferences = (settings: ServerSettingsPatch | ProjectSettingsOverrides) =>
    virtualModelRoles.some((role) => (settings as ServerSettingsPatch)[role]?.virtualModelId);
  const hasVirtual =
    file.scope === "project"
      ? file.virtualModels !== undefined || usesReferences(file.settings)
      : file.server.virtualModels !== undefined ||
        usesReferences(file.server) ||
        file.projects?.some(
          (project) => project.virtualModels !== undefined || usesReferences(project.settings),
        );
  if (hasVirtual)
    throw new Error(t("Update this environment's server before importing virtual models."));
}

function checkProviders(file: SettingsFile, target: ServerSettings, t: UiTranslator) {
  assertVirtualModelsSupported(file, target, t);
  const settings = file.scope === "project" ? file.settings : file.server;
  const optional = new Set(
    file.scope === "application" ? bindingProviders(file.server.virtualModels ?? null) : [],
  );
  const required = providerReferences(settings, false);
  const skipped = new Set<string>();
  const modelProviders =
    file.scope === "application"
      ? Object.keys(file.providerModels ?? {}).map((id) => ProviderInstanceId.make(id))
      : [];
  for (const id of new Set([...providerReferences(settings), ...modelProviders])) {
    const driver = file.providers[id];
    // Default instances use the driver ID and need no persisted configuration.
    const defaultDriver = getProviderClient(id);
    const destinationDriver =
      configuredTransferDriver(target, id) ??
      (defaultDriver?.hasDefaultInstance !== false ? defaultDriver?.driverKind : undefined);
    if (driver === undefined || destinationDriver !== driver) {
      if (optional.has(id) && !required.has(id)) {
        skipped.add(id);
        continue;
      }
      throw new Error(
        t(
          'Configure provider "{provider}" with the same driver on the destination before importing.',
          {
            provider: id,
          },
        ),
      );
    }
  }
  return skipped;
}

export function createApplicationSettingsFile(input: {
  readonly clientSettings: Partial<ClientSettings>;
  readonly server: ServerSettings;
  readonly keybindings: ApplicationSettingsFile["keybindings"];
  readonly theme?: ApplicationSettingsFile["theme"];
}): ApplicationSettingsFile {
  const providerModels = decodeProviderModels(
    Object.fromEntries(
      Object.entries(input.server.providerInstances).flatMap(([id, instance]) => {
        const config = instance.config;
        return config !== null &&
          typeof config === "object" &&
          !Array.isArray(config) &&
          "customModels" in config &&
          config.customModels !== undefined
          ? [[id, config.customModels]]
          : [];
      }),
    ),
  );
  const server = decodeApplicationServerSettings({
    ...Struct.omit(encodeApplicationServerSettings(input.server), ["virtualModels"]),
    ...(input.server.virtualModels ? { virtualModels: input.server.virtualModels } : {}),
    defaultThreadEnvMode: input.server.defaultThreadEnvMode,
    idleCompaction: globalIdleCompaction(input.server),
    favorites: input.server.favorites ?? input.clientSettings.favorites ?? [],
    providerModelPreferences:
      input.server.providerModelPreferences ?? input.clientSettings.providerModelPreferences ?? {},
  });
  return {
    format: "t3-code-settings",
    version: 1,
    scope: "application",
    clientSettings: decodeApplicationClientSettings(
      Struct.omit(input.clientSettings, ["voiceMicrophone"]),
    ),
    server,
    keybindings: input.keybindings.filter((rule) => !rule.command.startsWith("script.")),
    providers: providerDrivers(server, input.server, [
      ...Object.keys(providerModels).map((id) => ProviderInstanceId.make(id)),
      ...bindingProviders(input.server.virtualModels),
    ]),
    ...(Object.keys(providerModels).length > 0 ? { providerModels } : {}),
    ...(input.theme ? { theme: input.theme } : {}),
  };
}

export function createProjectSettingsFile(
  project: TransferProject,
  server: ServerSettings,
): ProjectSettingsFile {
  const settings = resolveProjectSettings(server, project.id).overrides;
  const virtualModels = projectVirtualModels(settings, server);
  const issueSources = projectIssueSourcesForTransfer(
    server.issueProjectSources[project.id],
    project.repositoryIdentity?.provider,
  );
  return {
    format: "t3-code-settings",
    version: 1,
    scope: "project",
    name: project.title,
    identity: projectTransferIdentity(project),
    settings,
    providers: providerDrivers(settings, server, bindingProviders(virtualModels)),
    ...(Object.keys(virtualModels).length ? { virtualModels } : {}),
    repositories: Object.fromEntries(
      (project.workspaceConfig?.roots ?? []).map((root) => [root.id, root.alias]),
    ),
    ...(issueSources === undefined ? {} : { issueSources }),
  };
}

export function serializeSettingsFile(file: SettingsFile): string {
  const portableFile =
    file.scope === "application"
      ? { ...file, clientSettings: Struct.omit(file.clientSettings, ["voiceMicrophone"]) }
      : file;
  const contents = `${JSON.stringify(encodeSettingsFile(portableFile), null, 2)}\n`;
  assertSettingsFileSize(new TextEncoder().encode(contents).byteLength);
  return contents;
}

export function assertSettingsFileSize(bytes: number): void {
  if (bytes > MAX_SETTINGS_FILE_BYTES)
    throw new Error("Settings files must be smaller than 1 MiB.");
}

export function parseSettingsFile(contents: string): SettingsFile {
  assertSettingsFileSize(contents.length);
  assertSettingsFileSize(new TextEncoder().encode(contents).byteLength);
  try {
    const file = decodeSettingsFile(JSON.parse(contents), {
      onExcessProperty: "error",
    });
    if (
      file.scope === "application" &&
      file.keybindings.some((rule) => !compileResolvedKeybindingRule(rule))
    ) {
      throw new Error("Invalid shortcut or condition.");
    }
    return file.scope === "application"
      ? { ...file, clientSettings: Struct.omit(file.clientSettings, ["voiceMicrophone"]) }
      : file;
  } catch (cause) {
    throw new Error("Invalid settings file. Check its format, version and setting values.", {
      cause,
    });
  }
}

export function applicationSettingsImportPatch(
  file: ApplicationSettingsFile,
  target: ServerSettings,
  t: UiTranslator = translateUi.bind(null, "en"),
  providers?: readonly ServerProvider[],
  generators?: ReadonlyMap<ProviderInstanceId, readonly string[]>,
): ServerSettingsPatch {
  const skipped = checkProviders(file, target, t);
  const providerInstances = Object.fromEntries(
    Object.entries(file.providerModels ?? {})
      .filter(([id]) => !skipped.has(id))
      .map(([providerId, customModels]) => {
        const id = ProviderInstanceId.make(providerId);
        const instance = target.providerInstances[id];
        const config = instance?.config;
        if (
          config !== undefined &&
          config !== null &&
          (typeof config !== "object" || Array.isArray(config))
        ) {
          throw new Error(
            t(
              'Repair provider "{provider}" settings on the destination before importing model edits.',
              {
                provider: id,
              },
            ),
          );
        }
        return [
          id,
          {
            ...instance,
            driver: instance?.driver ?? file.providers[id]!,
            config: { ...config, customModels },
          },
        ];
      }),
  );
  const server =
    file.server.requireConnectDeviceApproval === target.requireConnectDeviceApproval
      ? Struct.omit(file.server, ["requireConnectDeviceApproval"])
      : file.server;
  return {
    ...Struct.omit(server, ["virtualModels"]),
    ...(skipped.size && server.favorites
      ? {
          favorites: [
            ...server.favorites.filter((favorite) => !skipped.has(favorite.provider)),
            ...(target.favorites ?? []).filter((favorite) => skipped.has(favorite.provider)),
          ],
        }
      : {}),
    ...(skipped.size && server.providerModelPreferences
      ? {
          providerModelPreferences: Object.fromEntries([
            ...Object.entries(server.providerModelPreferences).filter(([id]) => !skipped.has(id)),
            ...Object.entries(target.providerModelPreferences ?? {}).filter(([id]) =>
              skipped.has(id),
            ),
          ]),
        }
      : {}),
    ...importedVirtualModels(
      file,
      { ...target, providerInstances: { ...target.providerInstances, ...providerInstances } },
      providers,
      generators,
    ),
    ...(Object.keys(providerInstances).length > 0
      ? { providerInstances: { ...target.providerInstances, ...providerInstances } }
      : {}),
  };
}

export function projectSettingsImportPatch(
  file: ProjectSettingsFile,
  project: TransferProject,
  target: ServerSettings,
  capabilities: Pick<ExecutionEnvironmentCapabilities, "singleProjectIssueProvider"> = {},
  t: UiTranslator = translateUi.bind(null, "en"),
  providers?: readonly ServerProvider[],
  generators?: ReadonlyMap<ProviderInstanceId, readonly string[]>,
): ServerSettingsPatch {
  checkProviders(file, target, t);
  const scripts = file.settings.defaultProjectScripts?.map((script) => ({
    ...script,
    ...(script.repositoryRootIds
      ? {
          repositoryRootIds: script.repositoryRootIds.map((id) => {
            const alias = file.repositories[id];
            const destination =
              alias && project.workspaceConfig?.roots.find((root) => root.alias === alias);
            if (!destination)
              throw new Error(
                t('Action "{action}" requires repository "{repository}" on the destination.', {
                  action: script.name,
                  repository: alias ?? id,
                }),
              );
            return destination.id;
          }),
        }
      : {}),
  }));
  return {
    ...importedVirtualModels(file, target, providers, generators),
    ...(file.issueSources === undefined
      ? {}
      : capabilities.singleProjectIssueProvider
        ? { issueProjectSources: { [project.id]: file.issueSources } }
        : importProjectIssueSources(
            project.id,
            file.issueSources,
            target.issueProjectSources[project.id] ?? [],
            project.repositoryIdentity?.provider,
          )),
    projectSettingsOverrides: {
      [project.id]:
        Object.keys(file.settings).length === 0
          ? null
          : {
              ...file.settings,
              ...(file.settings.providerInstances === undefined &&
              target.projectSettingsOverrides[project.id]?.providerInstances
                ? { providerInstances: {} }
                : {}),
              ...(scripts ? { defaultProjectScripts: scripts } : {}),
            },
    },
  };
}

export function projectConfigurationsForImport(
  file: SettingsFile,
): ReadonlyArray<ProjectImportDefinition> {
  if (file.scope === "application") return file.projects ?? [];
  if (!file.workspace) return [];
  return [
    {
      name: file.name,
      settings: file.settings,
      providers: file.providers,
      ...(file.virtualModels ? { virtualModels: file.virtualModels } : {}),
      workspace: file.workspace,
      ...(file.issueSources === undefined ? {} : { issueSources: file.issueSources }),
    },
  ];
}

function keybindingCondition(node: KeybindingWhenNode): string {
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!(${keybindingCondition(node.node)})`;
    case "and":
      return `(${keybindingCondition(node.left)}) && (${keybindingCondition(node.right)})`;
    case "or":
      return `(${keybindingCondition(node.left)}) || (${keybindingCondition(node.right)})`;
  }
}

export function settingsKeybindingsForExport(
  bindings: ResolvedKeybindingsConfig,
): ApplicationSettingsFile["keybindings"] {
  return bindings
    .filter((rule) => !rule.command.startsWith("script."))
    .map((rule) => {
      const shortcut = rule.shortcut;
      const key = [
        ...(shortcut.modKey ? ["mod"] : []),
        ...(shortcut.metaKey ? ["meta"] : []),
        ...(shortcut.ctrlKey ? ["ctrl"] : []),
        ...(shortcut.altKey ? ["alt"] : []),
        ...(shortcut.shiftKey ? ["shift"] : []),
        shortcut.key === " " ? "space" : shortcut.key,
      ].join("+");
      return {
        key,
        command: rule.command,
        ...(rule.whenAst ? { when: keybindingCondition(rule.whenAst) } : {}),
      };
    });
}

function keybindingFingerprint(rule: ResolvedKeybindingRule): string {
  const shortcut = rule.shortcut;
  return JSON.stringify([
    rule.command,
    shortcut.key,
    shortcut.modKey,
    shortcut.metaKey,
    shortcut.ctrlKey,
    shortcut.altKey,
    shortcut.shiftKey,
    rule.whenAst ? keybindingCondition(rule.whenAst) : null,
  ]);
}

export function settingsKeybindingsToImport(
  imported: ApplicationSettingsFile["keybindings"],
  current: ResolvedKeybindingsConfig,
): ApplicationSettingsFile["keybindings"] {
  const existing = new Set(current.map(keybindingFingerprint));
  const writes = imported.filter((rule) => {
    const resolved = compileResolvedKeybindingRule(rule);
    if (!resolved || rule.command.startsWith("script."))
      throw new Error("Invalid application shortcut.");
    const key = keybindingFingerprint(resolved);
    if (existing.has(key)) return false;
    existing.add(key);
    return true;
  });
  if (existing.size > MAX_KEYBINDINGS_COUNT)
    throw new Error(
      "Remove unused shortcuts before importing; the combined shortcut list is too large.",
    );
  return writes;
}

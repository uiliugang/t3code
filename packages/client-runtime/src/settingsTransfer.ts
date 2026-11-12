import {
  ClientSettingsPatch,
  CustomModelSetting,
  KeybindingsConfig,
  IssueSource,
  MAX_KEYBINDINGS_COUNT,
  ProjectSettingsOverrides,
  ProjectTransferWorkspace,
  ProjectImportDefinition,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
  globalIdleCompaction,
  TrimmedNonEmptyString,
  WorkspaceRootId,
  type ClientSettings,
  type EnvironmentId,
  type Project,
  type ResolvedKeybindingsConfig,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
} from "@t3tools/contracts";
import { canonicalRepositoryCloneKey } from "@t3tools/shared/git";
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

const APPLICATION_SERVER_SETTINGS_KEYS = [
  "favorites",
  "providerModelPreferences",
  "worktreeCleanup",
  "storageCleanup",
  "responseStreamingMode",
  "enableProviderUpdateChecks",
  "continueThreadsAfterServerUpdate",
  "enableAgentBrowserAccess",
  "speechModelId",
  "speechModelUnloadTimeout",
  "speechProjectCustomWords",
  "speechPostProcessingModelSelection",
  "defaultAutoPull",
  "defaultProjectScripts",
  "defaultRuntimeMode",
  "defaultModelSelection",
  "fallbackModelSelection",
  "enableAgentDeviceAccess",
  "enableDeviceSupport",
  "simlockDeviceHostsEnabled",
  "defaultThreadEnvMode",
  "newWorktreesStartFromOrigin",
  "newWorktreesMainBranchOnly",
  "remoteBranchDisplayDays",
  "hideMergedRemoteBranches",
  "autoDeleteMergedBranches",
  "worktreeSubmodules",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleOnMerge",
  "sidebarAutoSettleKeepPullRequests",
  "compactIdleThreads",
  "idleCompaction",
  "autoResumeLimitedThreads",
  "snoozeLimitedThreads",
  "snoozePresets",
  "hiddenThreadTags",
  "hideTaggedThreads",
  "guestSharingEnabled",
  "linkedEnvironmentsEnabled",
  "promptSuggestionsEnabled",
  "fastWorktreeCheckout",
  "backgroundActivity",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "backgroundActivityProfile",
  "textGenerationModelSelection",
  "threadTitleInstructions",
  "branchNamingMode",
  "branchNamePrefix",
  "branchNameInstructions",
  "sourceControlWritingStyle",
  "offeredSourceControlProviders",
  "sourceControlWriterModelSelection",
  "removeAgentCreditsOnMerge",
  "ghqCloneLayout",
  "reviewGuidesEnabled",
  "reviewGuideModelSelection",
  "reviewGuideInstructions",
  "pullRequestMergeMethod",
  "usagePriceOverrides",
  "usageModelAliases",
] as const;

const ApplicationServerSettings = Schema.Struct(
  Struct.pick(ServerSettingsPatch.fields, APPLICATION_SERVER_SETTINGS_KEYS),
);
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

function providerReferences(settings: ProjectSettingsOverrides | ServerSettingsPatch) {
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
    ].flatMap((selection) => (selection?.instanceId ? [selection.instanceId] : [])),
    ...Object.keys(settings.providerInstances ?? {}).map((id) => ProviderInstanceId.make(id)),
    ...("favorites" in settings ? (settings.favorites ?? []).map((entry) => entry.provider) : []),
    ...("providerModelPreferences" in settings
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
      source.providerInstances[id]?.driver ?? ProviderDriverKind.make(id),
    ]),
  );
}

function checkProviders(file: SettingsFile, target: ServerSettings, t: UiTranslator) {
  const settings = file.scope === "project" ? file.settings : file.server;
  const modelProviders =
    file.scope === "application"
      ? Object.keys(file.providerModels ?? {}).map((id) => ProviderInstanceId.make(id))
      : [];
  for (const id of new Set([...providerReferences(settings), ...modelProviders])) {
    const driver = file.providers[id];
    // Default instances use the driver ID and need no persisted configuration.
    const defaultDriver = getProviderClient(id);
    const destinationDriver =
      target.providerInstances[id]?.driver ??
      (defaultDriver?.hasDefaultInstance !== false ? defaultDriver?.driverKind : undefined);
    if (driver === undefined || destinationDriver !== driver) {
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
    ...encodeApplicationServerSettings(input.server),
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
    providers: providerDrivers(
      server,
      input.server,
      Object.keys(providerModels).map((id) => ProviderInstanceId.make(id)),
    ),
    ...(Object.keys(providerModels).length > 0 ? { providerModels } : {}),
    ...(input.theme ? { theme: input.theme } : {}),
  };
}

export function createProjectSettingsFile(
  project: TransferProject,
  server: ServerSettings,
): ProjectSettingsFile {
  const settings = resolveProjectSettings(server, project.id).overrides;
  return {
    format: "t3-code-settings",
    version: 1,
    scope: "project",
    name: project.title,
    identity: projectTransferIdentity(project),
    settings,
    providers: providerDrivers(settings, server),
    repositories: Object.fromEntries(
      (project.workspaceConfig?.roots ?? []).map((root) => [root.id, root.alias]),
    ),
    ...(Object.hasOwn(server.issueProjectSources, project.id)
      ? { issueSources: server.issueProjectSources[project.id]! }
      : {}),
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
): ServerSettingsPatch {
  checkProviders(file, target, t);
  const providerInstances = Object.fromEntries(
    Object.entries(file.providerModels ?? {}).map(([providerId, customModels]) => {
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
  return {
    ...file.server,
    ...(Object.keys(providerInstances).length > 0
      ? { providerInstances: { ...target.providerInstances, ...providerInstances } }
      : {}),
  };
}

export function projectSettingsImportPatch(
  file: ProjectSettingsFile,
  project: TransferProject,
  target: ServerSettings,
  t: UiTranslator = translateUi.bind(null, "en"),
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
    ...(file.issueSources === undefined
      ? {}
      : {
          issueProjectSources: {
            [project.id]: file.issueSources,
          },
        }),
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

import {
  ClientSettingsPatch,
  KeybindingsConfig,
  MAX_KEYBINDINGS_COUNT,
  ProjectSettingsOverrides,
  ProjectTransferWorkspace,
  ProjectImportDefinition,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsPatch,
  TrimmedNonEmptyString,
  WorkspaceRootId,
  type ClientSettings,
  type EnvironmentId,
  type Project,
  type ResolvedKeybindingsConfig,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
  type ServerSettings,
} from "@t3tools/contracts";
import { canonicalRepositoryCloneKey } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { compileResolvedKeybindingRule } from "@t3tools/shared/keybindings";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { getProviderClient } from "./providerClients.ts";

export const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;

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

const ApplicationServerSettings = Schema.Struct(
  Struct.pick(ServerSettingsPatch.fields, [
    "favorites",
    "providerModelPreferences",
    "responseStreamingMode",
    "enableProviderUpdateChecks",
    "continueThreadsAfterServerUpdate",
    "defaultAutoPull",
    "defaultProjectScripts",
    "defaultRuntimeMode",
    "defaultModelSelection",
    "defaultThreadEnvMode",
    "newWorktreesStartFromOrigin",
    "newWorktreesMainBranchOnly",
    "worktreeSubmodules",
    "sidebarAutoSettleAfterDays",
    "sidebarAutoSettleOnMerge",
    "sidebarAutoSettleKeepPullRequests",
    "autoResumeLimitedThreads",
    "snoozeLimitedThreads",
    "snoozePresets",
    "textGenerationModelSelection",
    "threadTitleInstructions",
    "branchNamingMode",
    "branchNamePrefix",
    "branchNameInstructions",
    "sourceControlWritingStyle",
    "sourceControlWriterModelSelection",
    "removeAgentCreditsOnMerge",
    "reviewGuidesEnabled",
    "reviewGuideModelSelection",
    "reviewGuideInstructions",
    "pullRequestMergeMethod",
    "usagePriceOverrides",
    "usageModelAliases",
  ]),
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

const ApplicationSettingsFile = Schema.Struct({
  ...commonFields,
  scope: Schema.Literal("application"),
  clientSettings: ApplicationClientSettings,
  server: ApplicationServerSettings,
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
  workspace: Schema.optionalKey(ProjectTransferWorkspace),
});

const SettingsFile = Schema.Union([ApplicationSettingsFile, ProjectSettingsFile]);
const decodeSettingsFile = Schema.decodeUnknownSync(SettingsFile);
const decodeApplicationClientSettings = Schema.decodeSync(ApplicationClientSettings);
const decodeApplicationServerSettings = Schema.decodeSync(ApplicationServerSettings);
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
      settings.textGenerationModelSelection,
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
) {
  return Object.fromEntries(
    [...providerReferences(settings)].map((id) => [
      id,
      source.providerInstances[id]?.driver ?? ProviderDriverKind.make(id),
    ]),
  );
}

function checkProviders(file: SettingsFile, target: ServerSettings) {
  const settings = file.scope === "project" ? file.settings : file.server;
  for (const id of providerReferences(settings)) {
    const driver = file.providers[id];
    // Default instances use the driver ID and need no persisted configuration.
    const defaultDriver = getProviderClient(id);
    const destinationDriver =
      target.providerInstances[id]?.driver ??
      (defaultDriver?.hasDefaultInstance !== false ? defaultDriver?.driverKind : undefined);
    if (driver === undefined || destinationDriver !== driver) {
      throw new Error(
        `Configure provider "${id}" with the same driver on the destination before importing.`,
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
  const server = decodeApplicationServerSettings({
    ...input.server,
    favorites: input.server.favorites ?? input.clientSettings.favorites ?? [],
    providerModelPreferences:
      input.server.providerModelPreferences ?? input.clientSettings.providerModelPreferences ?? {},
  });
  return {
    format: "t3-code-settings",
    version: 1,
    scope: "application",
    clientSettings: decodeApplicationClientSettings(input.clientSettings),
    server,
    keybindings: input.keybindings.filter((rule) => !rule.command.startsWith("script.")),
    providers: providerDrivers(server, input.server),
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
  };
}

export function serializeSettingsFile(file: SettingsFile): string {
  const contents = `${JSON.stringify(file, null, 2)}\n`;
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
    return file;
  } catch (cause) {
    throw new Error("Invalid settings file. Check its format, version and setting values.", {
      cause,
    });
  }
}

export function applicationSettingsImportPatch(
  file: ApplicationSettingsFile,
  target: ServerSettings,
): ServerSettingsPatch {
  checkProviders(file, target);
  return file.server;
}

export function projectSettingsImportPatch(
  file: ProjectSettingsFile,
  project: TransferProject,
  target: ServerSettings,
): ServerSettingsPatch {
  checkProviders(file, target);
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
                `Action "${script.name}" requires repository "${alias ?? id}" on the destination.`,
              );
            return destination.id;
          }),
        }
      : {}),
  }));
  return {
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

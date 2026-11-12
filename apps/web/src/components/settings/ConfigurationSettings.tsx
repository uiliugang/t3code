import { useAtomValue } from "@effect/atom-react";
import {
  applicationSettingsImportPatch,
  createApplicationSettingsFile,
  createProjectSettingsFile,
  projectSettingsImportPatch,
  projectTransferIdentity,
  settingsKeybindingsForExport,
  settingsKeybindingsToImport,
  type TransferProject,
} from "@t3tools/client-runtime/settings-transfer";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ServerSettings } from "@t3tools/contracts";
import { BUILT_IN_THEMES, RESERVED_THEME_IDS } from "@t3tools/shared/themePalettes";
import * as Struct from "effect/Struct";
import { useState } from "react";

import {
  ensureClientSettingsHydrated,
  getClientSettings,
  persistClientSettingsPatch,
} from "../../hooks/useSettings";
import { getThemeSnapshot, readThemeHalvesRaw, useTheme } from "../../hooks/useTheme";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  getCustomThemes,
  getThemeDefinition,
  installCustomTheme,
  isKnownThemePreference,
  parseThemeFile,
  serializeThemeFile,
  updateCustomTheme,
} from "../../themePalette";
import { SettingsTransfer } from "./SettingsTransfer";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { ProjectImportHistory } from "./ProjectImportHistory";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { EnvironmentScopeMenu } from "./SettingsScopeSentence";
import type { SettingsScopeSearch } from "./settingsScope";

export function ApplicationConfigurationSettings() {
  const t = useUiTranslation();
  const { scope, connectedEnvironments } = useSettingsScope();
  const [selection, setSelection] = useState<SettingsScopeSearch>({});
  const environment =
    connectedEnvironments.find((entry) => entry.environmentId === selection.machine) ??
    connectedEnvironments[0] ??
    null;
  const environmentId = environment?.environmentId ?? null;
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const canWriteBindings = useAtomValue(
    serverEnvironment.upsertKeybinding.permissionAtom(environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const upsertBinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const theme = useTheme();
  const exportProjects = useAtomCommand(sourceControlEnvironment.exportProjectConfigurations, {
    reportFailure: false,
  });
  const supportsProjectImport =
    environment?.serverConfig?.environment.capabilities.projectConfigurationImport === true;
  if (scope.kind === "project" || scope.kind === "checkout") return null;

  return (
    <SettingsSection id="settings-import-export" title={t("Import and export")}>
      {connectedEnvironments.length > 1 ? (
        <div className="px-4 py-3">
          <EnvironmentScopeMenu
            value={environment ? { machine: environment.environmentId } : {}}
            groups={[]}
            environments={connectedEnvironments}
            singleEnvironment
            onChange={setSelection}
          />
        </div>
      ) : null}
      {environment?.serverConfig ? (
        <SettingsTransfer
          key={environment.environmentId}
          scope="application"
          environmentId={environment.environmentId}
          supportsProjectImport={supportsProjectImport}
          title={environment.label}
          description={t(
            "Back up app preferences, themes, shortcuts, environment defaults and project/workspace definitions as JSON. Credentials and machine paths are excluded.",
          )}
          canImport={canWrite && canWriteBindings}
          createFile={async () => {
            await ensureClientSettingsHydrated();
            const config = appAtomRegistry.get(
              serverEnvironment.configValueAtom(environment.environmentId),
            );
            if (!config) throw new Error(t("Reconnect this environment before exporting."));
            const snapshot = getThemeSnapshot();
            const definitions = new Map(getCustomThemes().map((entry) => [entry.id, entry]));
            for (const id of [snapshot.theme, ...Object.values(readThemeHalvesRaw())]) {
              if (!id) continue;
              const definition = getThemeDefinition(id);
              if (definition && !definitions.has(id)) definitions.set(id, definition);
            }
            const exportedProjects = supportsProjectImport
              ? await exportProjects({ environmentId: environment.environmentId, input: {} })
              : null;
            if (exportedProjects?._tag === "Failure")
              throw squashAtomCommandFailure(exportedProjects);
            return {
              ...createApplicationSettingsFile({
                clientSettings: getClientSettings(),
                server: config.settings,
                keybindings: settingsKeybindingsForExport(config.keybindings),
                theme: {
                  preference: snapshot.theme,
                  mode: snapshot.appearanceMode,
                  halves: readThemeHalvesRaw(),
                  customThemes: [...definitions.values()]
                    .filter(
                      (definition) =>
                        !RESERVED_THEME_IDS.has(definition.id) &&
                        !BUILT_IN_THEMES.some((builtIn) => builtIn.id === definition.id),
                    )
                    .map((definition) => JSON.parse(serializeThemeFile(definition))),
                },
              }),
              ...(exportedProjects?._tag === "Success"
                ? { projects: exportedProjects.value.map((entry) => entry.configuration) }
                : {}),
            };
          }}
          importFile={async (file) => {
            if (file.scope !== "application")
              throw new Error(t("Choose an application settings file."));
            const current = appAtomRegistry.get(
              serverEnvironment.settingsValueAtom(environment.environmentId),
            );
            if (!current) throw new Error(t("Reconnect this environment before importing."));
            const patch = applicationSettingsImportPatch(file, current, t);
            const bindings = settingsKeybindingsToImport(
              file.keybindings,
              appAtomRegistry.get(serverEnvironment.configValueAtom(environment.environmentId))
                ?.keybindings ?? [],
            );
            const themes = file.theme?.customThemes.map(parseThemeFile) ?? [];
            for (const id of [file.theme?.preference, ...Object.values(file.theme?.halves ?? {})]) {
              if (id && !isKnownThemePreference(id) && !themes.some((entry) => entry.id === id))
                throw new Error(t('Theme "{id}" is not included in this backup.', { id }));
            }
            await ensureClientSettingsHydrated();
            const saved = await update({
              environmentId: environment.environmentId,
              input: { patch },
            });
            if (saved._tag === "Failure") throw squashAtomCommandFailure(saved);
            for (const rule of bindings) {
              const result = await upsertBinding({
                environmentId: environment.environmentId,
                input: rule,
              });
              if (result._tag === "Failure")
                throw new Error(
                  t("Import incomplete: some settings were saved, but a shortcut failed."),
                  { cause: squashAtomCommandFailure(result) },
                );
            }
            await persistClientSettingsPatch(file.clientSettings);
            for (const definition of themes) {
              if (getCustomThemes().some((entry) => entry.id === definition.id))
                updateCustomTheme(definition);
              else installCustomTheme(definition);
            }
            if (file.theme) {
              if (
                !theme.setTheme(file.theme.preference) ||
                !theme.setAppearanceMode(file.theme.mode)
              )
                throw new Error(
                  t("Import incomplete: settings were saved, but the theme could not be applied."),
                );
              for (const appearance of ["light", "dark"] as const) {
                const id = file.theme.halves[appearance];
                if (id && !theme.setThemeHalf(appearance, id))
                  throw new Error(t("Import incomplete: a theme preference could not be saved."));
              }
            }
          }}
        />
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          {t("Choose one connected environment to import or export app settings.")}
        </p>
      )}
      {supportsProjectImport && environment ? (
        <ProjectImportHistory environmentId={environment.environmentId} />
      ) : null}
    </SettingsSection>
  );
}

export function ProjectConfigurationSettings({
  project,
  settings,
}: {
  project: TransferProject;
  settings: ServerSettings;
}) {
  const t = useUiTranslation();
  const canWrite = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(project.environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const config = useAtomValue(serverEnvironment.configValueAtom(project.environmentId));
  const supportsProjectImport =
    config?.environment.capabilities.projectConfigurationImport === true;
  const exportProjects = useAtomCommand(sourceControlEnvironment.exportProjectConfigurations, {
    reportFailure: false,
  });
  const identity = projectTransferIdentity(project);
  return (
    <SettingsSection title={t("Project configuration")}>
      <div className="space-y-1 px-4 py-3 text-sm">
        <p>{project.workspaceRoot}</p>
        {identity.repository ? (
          <p className="break-all text-xs text-muted-foreground">
            Git: {identity.repository}
            {identity.directory ? ` · ${identity.directory}` : ""}
          </p>
        ) : null}
        <p className="break-all text-xs text-muted-foreground">{identity.id}</p>
        {identity.kind === "local" ? (
          <p className="text-xs text-muted-foreground">
            {t(
              "Local identity: Git metadata is unavailable, or this project contains multiple repositories.",
            )}
          </p>
        ) : null}
      </div>
      <SettingsTransfer
        title={project.title}
        description={t(
          "Transfer this checkout's explicit project overrides and actions. Inherited defaults and shortcuts stay in the environment.",
        )}
        scope="project"
        environmentId={project.environmentId}
        supportsProjectImport={supportsProjectImport}
        canImport={canWrite}
        createFile={async () => {
          const file = createProjectSettingsFile(
            project,
            appAtomRegistry.get(serverEnvironment.settingsValueAtom(project.environmentId)) ??
              settings,
          );
          if (!supportsProjectImport) return file;
          const exported = await exportProjects({
            environmentId: project.environmentId,
            input: { projectIds: [project.id] },
          });
          if (exported._tag === "Failure") throw squashAtomCommandFailure(exported);
          const definition = exported.value[0]?.configuration;
          if (!definition) throw new Error(t("This project is no longer available."));
          return {
            ...Struct.omit(file, ["issueSources"]),
            settings: definition.settings,
            providers: definition.providers,
            workspace: definition.workspace,
            ...(definition.issueSources === undefined
              ? {}
              : { issueSources: definition.issueSources }),
          };
        }}
        importFile={async (file) => {
          if (file.scope !== "project") throw new Error(t("Choose a project settings file."));
          const current = appAtomRegistry.get(
            serverEnvironment.settingsValueAtom(project.environmentId),
          );
          if (!current) throw new Error(t("Reconnect this environment before importing."));
          const result = await update({
            environmentId: project.environmentId,
            input: { patch: projectSettingsImportPatch(file, project, current, t) },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        }}
      />
      {supportsProjectImport ? (
        <ProjectImportHistory environmentId={project.environmentId} />
      ) : null}
    </SettingsSection>
  );
}

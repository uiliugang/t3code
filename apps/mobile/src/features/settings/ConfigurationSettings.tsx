import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  applicationSettingsImportPatch,
  createApplicationSettingsFile,
  createProjectSettingsFile,
  projectSettingsImportPatch,
  projectTransferIdentity,
  projectConfigurationsForImport,
  settingsKeybindingsForExport,
  settingsKeybindingsToImport,
  type SettingsFile,
  type TransferProject,
} from "@t3tools/client-runtime/settings-transfer";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ServerSettings, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Struct from "effect/Struct";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import {
  decodeMobileTransferPreferences,
  exportMobileTransferPreferences,
  mobileClientSettingsForExport,
  mobilePreferencesFromClientSettings,
} from "./mobileSettingsTransfer.logic";
import { pickSettingsFile, shareSettingsFile } from "./mobileSettingsTransfer";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { ProjectImportHistory } from "./ProjectImportHistory";
import { uuidv4 } from "../../lib/uuid";
import { useUiTranslation } from "../../lib/useUiTranslation";

function ConfigurationTransfer({
  title,
  scope,
  connected,
  canImport,
  createFile,
  importFile,
  environmentId,
  supportsProjectImport,
}: {
  title: string;
  scope: SettingsFile["scope"];
  connected: boolean;
  canImport: boolean;
  createFile: () => Promise<SettingsFile>;
  importFile: (file: SettingsFile) => Promise<void>;
  environmentId: EnvironmentId;
  supportsProjectImport: boolean;
}) {
  const t = useUiTranslation();
  const { lockSelection } = useSettingsEnvironmentFilter();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<SettingsFile | null>(null);
  const [materialize, setMaterialize] = useState(false);
  const [destinationDirectory, setDestinationDirectory] = useState("");
  const [importId, setImportId] = useState(uuidv4);
  const canClone = useAtomValue(
    sourceControlEnvironment.importProjectConfigurations.permissionAtom(environmentId),
  );
  const startImport = useAtomCommand(sourceControlEnvironment.importProjectConfigurations, {
    reportFailure: false,
  });
  const definitions = pending ? projectConfigurationsForImport(pending) : [];
  const requiresProjectCreation = pending?.scope === "project" && scope === "application";
  const reportFailure = (result: Awaited<ReturnType<typeof settlePromise>>) => {
    if (result._tag !== "Failure") return;
    const error = squashAtomCommandFailure(result);
    Dialog.alert(
      t("Settings transfer failed"),
      t(error instanceof Error ? error.message : "Try again."),
    );
  };
  const exportFile = async () => {
    if (!connected || busy) return;
    lockSelection();
    setBusy(true);
    const result = await settlePromise(async () => shareSettingsFile(await createFile()));
    setBusy(false);
    reportFailure(result);
  };
  const importSelection = async () => {
    if (!connected || busy) return;
    lockSelection();
    setBusy(true);
    const result = await settlePromise(async () => {
      const file = await pickSettingsFile();
      if (
        file &&
        file.scope !== scope &&
        !(supportsProjectImport && scope === "application" && file.scope === "project")
      )
        throw new Error(
          t(
            scope === "project"
              ? "Choose a project settings export."
              : "Choose an application settings export.",
          ),
        );
      return file;
    });
    setBusy(false);
    if (result._tag === "Failure") {
      reportFailure(result);
      return;
    }
    const file = result.value;
    if (!file) return;
    setPending(file);
    setMaterialize(file.scope === "project" && scope === "application");
    setImportId(uuidv4());
  };
  const confirmPending = () => {
    const file = pending;
    if (
      !file ||
      !connected ||
      busy ||
      !canImport ||
      (materialize && (!canClone || definitions.length === 0))
    )
      return;
    const details =
      file.scope === "project"
        ? `${t("Source: {name}", { name: file.name })}\n${file.identity.id}\n${t("Settings: {settings}", { settings: Object.keys(file.settings).join(", ") })}\n${(file.settings.defaultProjectScripts ?? []).map((script) => `${script.name}: ${script.command}`).join("\n")}`
        : t(
            "Environment settings: {settings}\nProvider models: {models}\nShortcuts: {count}\nNative preferences: {preferences}",
            {
              settings: Object.keys(file.server).join(", "),
              models: Object.keys(file.providerModels ?? {}).join(", "),
              count: file.keybindings.length,
              preferences: Object.keys(file.mobile ?? {}).join(", "),
            },
          );
    Dialog.confirm({
      title: t("Import into {name}?", { name: title }),
      message: `${details.slice(0, 6000)}\n\n${materialize ? t("Create projects/workspace groups in {directory} on this environment. Repositories are deduplicated and failed imports can be retried.", { directory: destinationDirectory.trim() || "~/projects" }) : t(file.scope === "project" ? "This replaces the checkout's project overrides. Missing settings inherit their defaults." : "Matching values will be replaced; other settings stay as they are. Web-only preferences stay on web and desktop.")}`,
      confirmText: t("Import settings"),
      cancelText: t("Cancel"),
      onConfirm: () => {
        setBusy(true);
        void settlePromise(async () => {
          if (materialize) {
            const result = await startImport({
              environmentId,
              input: {
                id: importId,
                projects: definitions,
                ...(destinationDirectory.trim()
                  ? { destinationDirectory: destinationDirectory.trim() }
                  : {}),
              },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          }
          if (!materialize || file.scope === "application") await importFile(file);
        }).then((saved) => {
          setBusy(false);
          if (saved._tag === "Failure") reportFailure(saved);
          else {
            setPending(null);
            Dialog.alert(t(materialize ? "Repository import queued" : "Settings imported"));
          }
        });
      },
    });
  };
  return (
    <>
      {!connected ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">
          {t("Reconnect this environment to import or export settings.")}
        </Text>
      ) : null}
      <ListActionRow
        icon="square.and.arrow.up"
        label={t("Export configuration")}
        description={title}
        disabled={busy || !connected}
        onPress={() => void exportFile()}
      />
      <View className="border-t border-border">
        <ListActionRow
          icon="arrow.down"
          label={t("Import configuration")}
          description={t("Choose a JSON export to review before saving.")}
          disabled={busy || !connected || !canImport}
          onPress={() => void importSelection()}
        />
      </View>
      {pending ? (
        <View className="gap-3 border-t border-border p-4">
          <Text className="text-sm text-foreground">
            {pending.scope === "project" ? pending.name : t("Application settings")}
          </Text>
          {requiresProjectCreation && definitions.length === 0 ? (
            <Text className="text-sm text-danger-foreground">
              {t(
                "This export has no clone information. Export it again from an updated environment.",
              )}
            </Text>
          ) : null}
          {supportsProjectImport && (definitions.length > 0 || requiresProjectCreation) ? (
            <>
              <SettingsSwitchRow
                label={t("Clone repositories and create projects/workspace groups")}
                value={materialize}
                disabled={busy || requiresProjectCreation || !canClone}
                onValueChange={setMaterialize}
              />
              {materialize ? (
                <AppTextInput
                  accessibilityLabel={t("Clone destination directory")}
                  placeholder={t("Optional directory (default: ~/projects)")}
                  value={destinationDirectory}
                  onChangeText={setDestinationDirectory}
                  editable={!busy}
                  className="min-h-12 rounded-xl bg-input px-3 text-sm text-foreground"
                />
              ) : null}
            </>
          ) : null}
          <Button
            label={t(busy ? "Importing…" : "Import settings")}
            disabled={
              busy ||
              !connected ||
              !canImport ||
              (materialize && (!canClone || definitions.length === 0))
            }
            onPress={confirmPending}
          />
          <Button
            label={t("Cancel")}
            tone="text"
            disabled={busy}
            onPress={() => setPending(null)}
          />
        </View>
      ) : null}
    </>
  );
}

export function ProjectConfigurationSettings({
  project,
  settings,
  connected,
}: {
  project: TransferProject;
  settings: ServerSettings;
  connected: boolean;
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
    <SettingsSection title="Project configuration">
      <View className="gap-1 p-4">
        <Text selectable className="text-sm text-foreground">
          {project.workspaceRoot}
        </Text>
        {identity.repository ? (
          <Text selectable className="text-xs text-foreground-muted">
            Git: {identity.repository}
            {identity.directory ? ` · ${identity.directory}` : ""}
          </Text>
        ) : null}
        <Text selectable className="text-xs text-foreground-muted">
          {identity.id}
        </Text>
        {identity.kind === "local" ? (
          <Text className="text-xs text-foreground-muted">
            {t("This identity is local to this environment.")}
          </Text>
        ) : null}
      </View>
      <ConfigurationTransfer
        scope="project"
        connected={connected}
        environmentId={project.environmentId}
        supportsProjectImport={supportsProjectImport}
        title={project.title}
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

export function ApplicationConfigurationSettings({ environment }: { environment: SettingsTarget }) {
  const t = useUiTranslation();
  const environmentId = environment.environmentId;
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const canWriteBindings = useAtomValue(
    serverEnvironment.upsertKeybinding.permissionAtom(environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const upsertBinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const savePreferences = useAtomSet(updateMobilePreferencesAtom, { mode: "promiseExit" });
  const supportsProjectImport =
    environment.serverConfig.environment.capabilities.projectConfigurationImport === true;
  const exportProjects = useAtomCommand(sourceControlEnvironment.exportProjectConfigurations, {
    reportFailure: false,
  });
  return (
    <SettingsSection title="Import and export">
      <ConfigurationTransfer
        scope="application"
        connected={environment.connection.phase === "connected"}
        environmentId={environmentId}
        supportsProjectImport={supportsProjectImport}
        title={environment.label}
        canImport={canWrite && canWriteBindings}
        createFile={async () => {
          const preferences = appAtomRegistry.get(mobilePreferencesAtom);
          if (!AsyncResult.isSuccess(preferences))
            throw new Error(t("Wait for app preferences to load before exporting."));
          const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
          if (!config) throw new Error(t("Reconnect this environment before exporting."));
          const exportedProjects = supportsProjectImport
            ? await exportProjects({ environmentId, input: {} })
            : null;
          if (exportedProjects?._tag === "Failure")
            throw squashAtomCommandFailure(exportedProjects);
          return {
            ...createApplicationSettingsFile({
              clientSettings: mobileClientSettingsForExport(preferences.value),
              server: config.settings,
              keybindings: settingsKeybindingsForExport(config.keybindings),
            }),
            mobile: exportMobileTransferPreferences(preferences.value),
            ...(exportedProjects?._tag === "Success"
              ? { projects: exportedProjects.value.map((entry) => entry.configuration) }
              : {}),
          };
        }}
        importFile={async (file) => {
          if (file.scope !== "application")
            throw new Error(t("Choose an application settings file."));
          const current = appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId));
          if (!current) throw new Error(t("Reconnect this environment before importing."));
          const patch = applicationSettingsImportPatch(file, current, t);
          const bindings = settingsKeybindingsToImport(
            file.keybindings,
            appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.keybindings ??
              [],
          );
          const preferences = decodeMobileTransferPreferences(file.mobile ?? {}, {
            onExcessProperty: "error",
          });
          const result = await update({ environmentId, input: { patch } });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          for (const rule of bindings) {
            const saved = await upsertBinding({ environmentId, input: rule });
            if (saved._tag === "Failure")
              throw new Error(
                t("Import incomplete: environment settings were saved, but a shortcut failed."),
                { cause: squashAtomCommandFailure(saved) },
              );
          }
          const saved = await savePreferences({
            ...mobilePreferencesFromClientSettings(file.clientSettings),
            ...preferences,
          });
          if (Exit.isFailure(saved))
            throw new Error(
              t("Import incomplete: environment settings were saved, but app preferences failed."),
              { cause: Cause.squash(saved.cause) },
            );
        }}
      />
      {supportsProjectImport ? <ProjectImportHistory environmentId={environmentId} /> : null}
    </SettingsSection>
  );
}

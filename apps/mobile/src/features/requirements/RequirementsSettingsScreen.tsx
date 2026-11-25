import { useAtomValue } from "@effect/atom-react";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { mergeProjectIssueSources, projectIssueProvider } from "@t3tools/contracts";
import {
  detectedProjectIssueKind,
  listedProjectIssueSources,
} from "@t3tools/client-runtime/issueSources";
import {
  meituanAssociationCountLabel,
  mepAccountLabel,
  mepTrackerSummary,
} from "@t3tools/client-runtime/meituanSettings";
import {
  EnvironmentId,
  isMeituanServiceEnabled,
  MAX_WORK_ITEM_DISCOVERY_LIMIT,
  WorkItemDiscoveryLimit,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { IssueTrackerSection } from "../settings/components/IssueTrackerSection";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { SourceControlSignInSection } from "../settings/components/SourceControlSignInSection";
import { SourceControlToolsSection } from "../settings/components/SourceControlToolsSection";
import {
  useSettingsEnvironmentFilter,
  type SettingsTarget,
} from "../settings/settings-environment-filter";
import { settingsEditorTarget } from "../settings/settings-environment-filter.logic";
import { IssuePicker } from "./IssuePicker";
import { ProjectSourcesRow } from "./ProjectSourcesRow";

export function RequirementsSettingsScreen({
  route,
}: StaticScreenProps<{ environmentId?: EnvironmentId } | undefined>) {
  const t = useUiTranslation();
  const insets = useSafeAreaInsets();
  const { availableTargets, selectedTargets, selectedIds } = useSettingsEnvironmentFilter();
  const navigation =
    useNavigation<
      NativeStackNavigationProp<ReactNavigation.RootParamList, "SettingsRequirements">
    >();
  const selected = route.params?.environmentId;
  const environment = settingsEditorTarget(selected, availableTargets, selectedTargets);
  return (
    <SettingsScreen title={t("Issue management")}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <IssuePicker
          label={t("Environment")}
          value={environment?.environmentId ?? ""}
          options={availableTargets.map((entry) => ({
            value: entry.environmentId,
            label: entry.label,
          }))}
          onChange={(value) => navigation.setParams({ environmentId: EnvironmentId.make(value) })}
        />
        {environment ? (
          <EnvironmentRequirements key={environment.environmentId} environment={environment} />
        ) : (
          <Text>
            {t(
              selected || selectedIds?.size
                ? "The selected environment is offline."
                : "Choose an environment to configure issue sources.",
            )}
          </Text>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function EnvironmentRequirements({ environment }: { environment: SettingsTarget }) {
  const t = useUiTranslation();
  const { environmentId, serverConfig } = environment;
  const settings =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId)) ?? serverConfig.settings;
  const enabled = isMeituanServiceEnabled(settings, "requirements");
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const projects = useProjects().filter((p) => p.environmentId === environmentId && !p.isScratch);
  const query = useEnvironmentQuery(
    projects.length
      ? sourceControlEnvironment.issueSources({
          environmentId,
          input: { projectIds: projects.map((p) => p.id) },
        })
      : null,
  );
  const byId = new Map(query.data?.map((row) => [row.projectId, row]));
  const singleProvider = serverConfig.environment.capabilities.singleProjectIssueProvider === true;
  const compareAndSet = serverConfig.environment.capabilities.issueProjectSourcesCas === true;
  const rows = projects.map((project) => {
    const result = byId.get(project.id);
    const saved = settings.issueProjectSources[project.id] ?? [];
    const kind = detectedProjectIssueKind(project.repositoryIdentity, result);
    const sources = mergeProjectIssueSources(result?.sources ?? [], saved, kind);
    return {
      project,
      result,
      saved,
      sources,
      associated: (singleProvider
        ? sources
        : listedProjectIssueSources(false, result?.sources ?? [], saved, kind)
      ).some((source) => source.provider === "meituan"),
      provider: projectIssueProvider(kind, sources),
    };
  });
  return (
    <>
      <IssueTrackerSection environment={environment}>
        {enabled ? (
          <MepTracker
            environment={environment}
            projects={meituanAssociationCountLabel(
              projects.length,
              query,
              rows.filter((row) => row.associated).length,
              t,
            )}
          />
        ) : null}
      </IssueTrackerSection>
      {serverConfig.workItemDiscoverySettings ? (
        <DiscoveredTasksSettings
          environmentId={environmentId}
          enabled={settings.workItemDiscoveryEnabled}
          maxTasks={settings.workItemDiscoveryLimit}
          allowed={allowed}
        />
      ) : null}
      <SettingsSection
        title={t("Project issue sources")}
        footer={!allowed || !compareAndSet ? t("Read-only") : undefined}
      >
        {query.error ? (
          <Text accessibilityRole="alert" className="p-3 text-danger">
            {query.error}
          </Text>
        ) : null}
        {!rows.length ? (
          <Text className="p-3 text-foreground-muted">{t("No matching projects.")}</Text>
        ) : null}
        {rows.map(({ project, result, saved, sources, provider }) => (
          <ProjectSourcesRow
            key={JSON.stringify([project.id, enabled, provider])}
            environmentId={environmentId}
            projectId={project.id}
            title={project.title}
            repository={result?.repository ?? null}
            saved={saved}
            singleProvider={singleProvider}
            compareAndSet={compareAndSet}
            sources={sources}
            provider={provider}
            error={result?.error ?? query.error ?? undefined}
            discovery={query.error || result?.error ? "failed" : result ? "ready" : "pending"}
            mep={enabled}
            allowed={allowed}
          />
        ))}
      </SettingsSection>
      <SourceControlSignInSection environments={[environment]} canWrite={() => allowed} />
    </>
  );
}

const isDiscoveryLimit = Schema.is(WorkItemDiscoveryLimit);

function DiscoveredTasksSettings({
  environmentId,
  enabled,
  maxTasks,
  allowed,
}: {
  environmentId: EnvironmentId;
  enabled: boolean;
  maxTasks: number;
  allowed: boolean;
}) {
  const t = useUiTranslation();
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const limit = Number(draft ?? maxTasks);
  const valid = isDiscoveryLimit(limit);
  const disabled = !allowed || saving;
  const range = t("Enter a whole number from 1 to {max}.", { max: MAX_WORK_ITEM_DISCOVERY_LIMIT });
  const save = async (patch: ServerSettingsPatch) => {
    setSaving(true);
    const result = await update({ environmentId, input: { patch } });
    if (result._tag === "Success" && patch.workItemDiscoveryLimit !== undefined) setDraft(null);
    setSaving(false);
  };

  return (
    <SettingsSection title={t("Discovered tasks")} footer={!allowed ? t("Read-only") : undefined}>
      <SettingsSwitchRow
        label={t("Enable task discovery")}
        value={enabled}
        disabled={disabled}
        onValueChange={(workItemDiscoveryEnabled) => void save({ workItemDiscoveryEnabled })}
      />
      <View className="gap-2 p-4">
        <ConnectionFormField
          label={t("Maximum discovered tasks")}
          accessibilityHint={range}
          keyboardType="number-pad"
          value={draft ?? String(maxTasks)}
          editable={!disabled}
          onChangeText={setDraft}
        />
        <Text className={valid ? "text-xs text-foreground-muted" : "text-xs text-danger"}>
          {range}
        </Text>
        <View className="self-start">
          <Button
            label={t("Save")}
            disabled={disabled || !valid || limit === maxTasks}
            onPress={() => void save({ workItemDiscoveryLimit: limit })}
          />
        </View>
      </View>
    </SettingsSection>
  );
}

function MepTracker({ environment, projects }: { environment: SettingsTarget; projects: string }) {
  const t = useUiTranslation();
  const [open, setOpen] = useState(false);
  const { environmentId, serverConfig } = environment;
  const supported = serverConfig.environment.capabilities.meituanTools === true;
  const tools = useEnvironmentQuery(
    supported ? sourceControlEnvironment.meituanTools({ environmentId, input: {} }) : null,
  );
  const ones = tools.data?.tools.find((tool) => tool.id === "ones2");
  return (
    <>
      <SettingsRow
        icon="ticket"
        label={t("MEP ONES")}
        value={[t("Enabled"), mepTrackerSummary(ones, projects, t)].join(" · ")}
        valuePosition="below"
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <>
          <SettingsRow
            icon="person.2"
            label={t("ONES account")}
            value={`${mepAccountLabel(ones, t)} · mep.sankuai.com`}
            valuePosition="below"
          />
          {ones?.status === "installed" && ones.account === null ? (
            <Text className="px-4 text-sm text-foreground-muted">
              {t("Configure ONES in this environment's terminal, then detect again.")}
            </Text>
          ) : null}
          {supported ? (
            <SourceControlToolsSection environment={environment} only={["ones2", "mcm"]} inline />
          ) : (
            <Text className="p-3">{t("Server update required")}</Text>
          )}
        </>
      ) : null}
    </>
  );
}

import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, ProjectId, type IssueProvider } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SourceControlSignInSection } from "../settings/components/SourceControlSignInSection";
import { useSettingsEnvironmentFilter } from "../settings/settings-environment-filter";
import { IssuePicker } from "./IssuePicker";

export function RequirementsSettingsScreen() {
  const t = useUiTranslation();
  const { availableTargets } = useSettingsEnvironmentFilter();
  const [selectedEnvironment, setEnvironment] = useState<EnvironmentId | null>(null);
  const environment =
    availableTargets.find((entry) => entry.environmentId === selectedEnvironment) ??
    availableTargets[0];
  const allowed = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environment?.environmentId ?? null),
  );
  return (
    <SettingsScreen title="Issue management">
      <ScreenScrollView className="flex-1" contentContainerClassName="gap-5 px-5 pb-12">
        <IssuePicker
          label={t("Environment")}
          value={environment?.environmentId ?? ""}
          options={availableTargets.map((entry) => ({
            value: entry.environmentId,
            label: entry.label,
          }))}
          onChange={(value) => setEnvironment(EnvironmentId.make(value))}
        />
        {environment ? (
          <>
            <ProjectSources
              key={environment.environmentId}
              environmentId={environment.environmentId}
            />
            <SourceControlSignInSection environments={[environment]} canWrite={() => allowed} />
          </>
        ) : (
          <Text>{t("Choose an environment to configure issue sources.")}</Text>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function ProjectSources({ environmentId }: { environmentId: EnvironmentId }) {
  const t = useUiTranslation();
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && !project.isScratch,
  );
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const saved = settings?.issueProjectSources ?? {};
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const command = useAtomCommand(serverEnvironment.updateSettings);
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [provider, setProvider] = useState<IssueProvider>("meituan");
  const [scope, setScope] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = projectId ?? projects[0]?.id;
  const save = async () => {
    if (!selected) return;
    setBusy(true);
    const result = await command({
      environmentId,
      input: {
        patch: {
          issueProjectSources: {
            [selected]: [
              ...(saved[selected] ?? []).filter((entry) => entry.provider !== provider),
              {
                provider,
                scope: scope.trim(),
                host: provider === "meituan" ? "mep.sankuai.com" : "github.com",
              },
            ],
          },
        },
      },
    });
    setBusy(false);
    if (result._tag === "Success") setScope("");
  };
  const remove = async (id: ProjectId, kind: IssueProvider) => {
    setBusy(true);
    await command({
      environmentId,
      input: {
        patch: {
          issueProjectSources: {
            [id]: (saved[id] ?? []).filter((entry) => entry.provider !== kind),
          },
        },
      },
    });
    setBusy(false);
  };
  const valid =
    provider === "meituan" ? /^[1-9]\d*$/u.test(scope) : /^[\w.-]+\/[\w.-]+$/u.test(scope);
  return (
    <View className="gap-4">
      {projects.flatMap((project) =>
        (saved[project.id] ?? []).map((source) => (
          <View
            key={`${project.id}/${source.provider}`}
            className="gap-2 border-b border-border-subtle py-3"
          >
            <Text>
              {project.title} · {source.provider === "meituan" ? "MEP ONES" : "GitHub Issues"}
            </Text>
            <Text className="text-foreground-muted">{source.scope}</Text>
            <Button
              label={t("Remove issue source")}
              tone="text"
              disabled={!allowed || busy}
              onPress={() => void remove(project.id, source.provider)}
            />
          </View>
        )),
      )}
      <IssuePicker
        label={t("Project")}
        value={selected ?? ""}
        options={projects.map((project) => ({ value: project.id, label: project.title }))}
        onChange={(value) => setProjectId(ProjectId.make(value))}
        disabled={!allowed || busy}
      />
      <IssuePicker
        label={t("Issue source")}
        value={provider}
        options={[
          { value: "meituan", label: "MEP ONES" },
          { value: "github", label: "GitHub Issues" },
        ]}
        onChange={(value) => {
          setProvider(value === "github" ? "github" : "meituan");
          setScope("");
        }}
        disabled={!allowed || busy}
      />
      <AppTextInput
        accessibilityLabel={t(provider === "meituan" ? "MEP space ID" : "GitHub repository")}
        placeholder={provider === "meituan" ? "1031008" : "owner/repository"}
        value={scope}
        onChangeText={setScope}
        editable={allowed && !busy}
        autoCapitalize="none"
      />
      <Button
        label={t("Save issue source")}
        icon="plus"
        disabled={!allowed || busy || !selected || !valid}
        onPress={() => void save()}
      />
    </View>
  );
}

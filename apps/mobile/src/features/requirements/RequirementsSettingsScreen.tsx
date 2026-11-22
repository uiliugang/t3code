import { useAtomValue } from "@effect/atom-react";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import {
  mergeProjectIssueSources,
  parseMepSpaceIds,
  projectIssueSourceEdit,
  withGithubRepositoryOverride,
  withMepSpaceOverrides,
} from "@t3tools/client-runtime/issueSources";
import {
  meituanAssociationCountLabel,
  mepAccountLabel,
  mepSpaceValue,
  mepTrackerSummary,
} from "@t3tools/client-runtime/meituanSettings";
import {
  EnvironmentId,
  isMeituanServiceEnabled,
  type IssueSource,
  type ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { IssueTrackerSection } from "../settings/components/IssueTrackerSection";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SourceControlSignInSection } from "../settings/components/SourceControlSignInSection";
import { SourceControlToolsSection } from "../settings/components/SourceControlToolsSection";
import {
  useSettingsEnvironmentFilter,
  type SettingsTarget,
} from "../settings/settings-environment-filter";
import { settingsEditorTarget } from "../settings/settings-environment-filter.logic";
import { IssuePicker } from "./IssuePicker";

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
  const rows = projects.map((project) => {
    const result = byId.get(project.id);
    const saved = settings.issueProjectSources[project.id] ?? [];
    return {
      project,
      result,
      saved,
      sources: mergeProjectIssueSources(result?.sources ?? [], saved),
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
              rows.filter((row) => row.sources.some((s) => s.provider === "meituan")).length,
              t,
            )}
          />
        ) : null}
      </IssueTrackerSection>
      <SettingsSection
        title={t("Project issue sources")}
        footer={!allowed ? t("Read-only") : undefined}
      >
        {query.error ? (
          <Text accessibilityRole="alert" className="p-3 text-danger">
            {query.error}
          </Text>
        ) : null}
        {!rows.length ? (
          <Text className="p-3 text-foreground-muted">{t("No matching projects.")}</Text>
        ) : null}
        {rows.map(({ project, result, saved, sources }) => (
          <ProjectSourcesRow
            key={JSON.stringify([project.id, enabled])}
            environmentId={environmentId}
            projectId={project.id}
            title={project.title}
            repository={result?.repository ?? null}
            saved={saved}
            sources={sources}
            error={result?.error}
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

type SourceEdit = { provider: "meituan" } | { provider: "github"; source: IssueSource | undefined };

function ProjectSourcesRow({
  environmentId,
  projectId,
  title,
  repository,
  saved,
  sources,
  error,
  discovery,
  mep,
  allowed,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  title: string;
  repository: string | null;
  saved: readonly IssueSource[];
  sources: readonly IssueSource[];
  error: string | undefined;
  discovery: "pending" | "failed" | "ready";
  mep: boolean;
  allowed: boolean;
}) {
  const t = useUiTranslation();
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [editing, setEditing] = useState<(SourceEdit & { saved: readonly IssueSource[] }) | null>(
    null,
  );
  const [draft, setDraft] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const githubSources = sources.filter((s) => s.provider === "github");
  const spaces = sources.filter((s) => s.provider === "meituan").map((s) => s.scope);
  const manual = saved.some((s) => s.provider === "meituan");
  const valid =
    editing?.provider === "meituan"
      ? parseMepSpaceIds(draft) !== null
      : draft.trim().length <= 200 && /^[\w.-]+\/[\w.-]+$/u.test(draft.trim());
  const edit = (target: SourceEdit) => {
    setEditing({ ...target, saved });
    setDraft(target.provider === "meituan" ? spaces.join(", ") : (target.source?.scope ?? ""));
    setFailure(null);
  };
  const save = async (restore: boolean) => {
    if (
      !editing ||
      busy ||
      !allowed ||
      (!restore && !valid) ||
      (editing.provider === "meituan" && !mep)
    )
      return;
    const input = projectIssueSourceEdit(
      projectId,
      editing.provider,
      saved,
      editing.saved,
      (latest) =>
        editing.provider === "meituan"
          ? withMepSpaceOverrides(latest, restore ? [] : (parseMepSpaceIds(draft) ?? []))
          : withGithubRepositoryOverride(latest, editing.source, restore ? null : draft.trim()),
    );
    if (!input) {
      setFailure(t("Project sources have changed. Reopen the editor and try again."));
      return;
    }
    setBusy(true);
    setFailure(null);
    const result = await update({ environmentId, input });
    if (result._tag === "Success") {
      setEditing(null);
    } else setFailure(t("Could not save project sources. Reopen the editor and try again."));
    setBusy(false);
  };
  return (
    <View className="gap-2 border-b border-border-subtle px-4 py-3">
      <View>
        <Text textRole="body" className="font-t3-semibold">
          {title}
        </Text>
        {repository && !githubSources.some((source) => source.scope === repository) ? (
          <Text textRole="footnote" className="text-foreground-muted">
            {repository}
          </Text>
        ) : null}
      </View>
      {error ? (
        <Text accessibilityRole="alert" className="text-danger">
          {error}
        </Text>
      ) : null}
      {editing && (editing.provider !== "meituan" || mep) ? (
        <View className="gap-2 border-t border-border-subtle pt-3">
          <Text textRole="footnote" className="font-t3-medium">
            {t(editing.provider === "meituan" ? "MEP space IDs" : "GitHub repository")}
            {editing.provider === "github" ? ` · ${editing.source?.host ?? "github.com"}` : ""}
          </Text>
          <AppTextInput
            accessibilityLabel={t(
              editing.provider === "meituan" ? "MEP space IDs" : "GitHub repository",
            )}
            value={draft}
            onChangeText={setDraft}
            editable={allowed && !busy}
            placeholder={editing.provider === "meituan" ? "10001, 10002" : "owner/repository"}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {!valid && editing.provider === "meituan" ? (
            <Text className="text-sm text-danger">
              {t("Enter positive space IDs separated by commas.")}
            </Text>
          ) : null}
          {failure ? (
            <Text accessibilityRole="alert" className="text-danger">
              {failure}
            </Text>
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            <Button
              size="compact"
              label={t("Save")}
              tone="primary"
              disabled={!valid || busy || !allowed}
              onPress={() => void save(false)}
            />
            <Button
              size="compact"
              label={t("Cancel")}
              tone="text"
              disabled={busy}
              onPress={() => setEditing(null)}
            />
            {saved.some((s) => s.provider === editing.provider) ? (
              <Button
                size="compact"
                label={t(
                  editing.provider === "github" && githubSources.length > 1
                    ? "Remove"
                    : "Restore automatic",
                )}
                tone="text"
                disabled={!allowed || busy}
                onPress={() => void save(true)}
              />
            ) : null}
          </View>
        </View>
      ) : (
        <>
          <View>
            <Text textRole="label" className="font-t3-medium text-foreground-muted">
              {t("GitHub Issues")}
            </Text>
            {(githubSources.length ? githubSources : [undefined]).map((source) => (
              <ProjectSourceLine
                key={source ? JSON.stringify([source.host, source.scope]) : "github"}
                value={
                  source?.scope ??
                  t(
                    discovery === "pending"
                      ? "Loading..."
                      : discovery === "failed"
                        ? "Unknown"
                        : "Not configured",
                  )
                }
                detail={source?.host}
                actionLabel={
                  source
                    ? t("Edit {name}", { name: `${source.host}/${source.scope}` })
                    : t("GitHub repository")
                }
                add={!source}
                onEdit={allowed ? () => edit({ provider: "github", source }) : undefined}
              />
            ))}
          </View>
          {mep ? (
            <View className="border-t border-border-subtle pt-2">
              <Text textRole="label" className="font-t3-medium text-foreground-muted">
                {t("MEP space IDs")}
              </Text>
              <ProjectSourceLine
                value={mepSpaceValue(spaces, discovery, t)}
                detail={spaces.length ? t(manual ? "Manual override" : "Automatic") : undefined}
                actionLabel={t(
                  spaces.length || discovery !== "ready" ? "Edit spaces" : "Link spaces",
                )}
                add={!spaces.length && discovery === "ready"}
                onEdit={allowed ? () => edit({ provider: "meituan" }) : undefined}
              />
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

function ProjectSourceLine({
  value,
  detail,
  actionLabel,
  add,
  onEdit,
}: {
  value: string;
  detail: string | undefined;
  actionLabel: string;
  add: boolean;
  onEdit: (() => void) | undefined;
}) {
  return (
    <View className="min-h-12 flex-row items-center gap-2">
      <View className="min-w-0 flex-1 py-1">
        <Text textRole="body">{value}</Text>
        {detail ? (
          <Text textRole="label" className="text-foreground-muted">
            {detail}
          </Text>
        ) : null}
      </View>
      {onEdit ? (
        <IconButton
          icon={add ? "plus" : "pencil"}
          accessibilityLabel={actionLabel}
          onPress={onEdit}
          tintColorClassName="accent-primary-text"
        />
      ) : null}
    </View>
  );
}

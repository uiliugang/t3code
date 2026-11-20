import { useState, type ComponentProps } from "react";
import { View } from "react-native";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, isMeituanServiceEnabled, type SkillSource } from "@t3tools/contracts";
import { mergeProjectIssueSources } from "@t3tools/client-runtime/issueSources";
import {
  meituanAssociationCountLabel,
  meituanToolIdsForSection,
  shouldDiscoverMeituanProjectSources,
} from "@t3tools/client-runtime/meituanSettings";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import * as Dialog from "../../components/ui/Dialog";
import { useEnvironmentQuery } from "../../state/query";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { IssuePicker } from "../requirements/IssuePicker";
import { ProjectSources } from "../requirements/RequirementsSettingsScreen";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { MeituanCodeSettingsSection } from "./components/MeituanCodeSettingsSection";
import { SourceControlToolsSection } from "./components/SourceControlToolsSection";
import { DaxiangSettingsSection } from "./DaxiangSettingsSection";
import { WechatSettingsSection } from "./WechatSettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

type Params = { environmentId?: EnvironmentId };
type Props = StaticScreenProps<Params | undefined>;
type Section = "code" | "issues" | "daxiang" | "skills" | "access";

export function SettingsMeituanRouteScreen(props: Props) {
  return <IntegrationScreen {...props} />;
}
export function SettingsMeituanCodeRouteScreen(props: Props) {
  return <IntegrationScreen {...props} section="code" />;
}
export function SettingsMeituanIssuesRouteScreen(props: Props) {
  return <IntegrationScreen {...props} section="issues" />;
}
export function SettingsMeituanDaxiangRouteScreen(props: Props) {
  return <IntegrationScreen {...props} section="daxiang" />;
}
export function SettingsMeituanSkillsRouteScreen(props: Props) {
  return <IntegrationScreen {...props} section="skills" />;
}
export function SettingsSharingAccessRouteScreen(props: Props) {
  return <IntegrationScreen {...props} section="access" />;
}

function IntegrationScreen({ route, section }: Props & { section?: Section }) {
  const t = useUiTranslation();
  const { availableTargets, selectedTargets } = useSettingsEnvironmentFilter();
  const [selected, setSelected] = useState(route.params?.environmentId);
  const environment = selected
    ? availableTargets.find((entry) => entry.environmentId === selected)
    : (selectedTargets[0] ?? availableTargets[0]);
  const title =
    section === "code"
      ? "Meituan Code"
      : section === "issues"
        ? "Requirements and delivery"
        : section === "daxiang"
          ? "DaXiang"
          : section === "skills"
            ? "Meituan Skills"
            : section === "access"
              ? "Sharing & access"
              : "Meituan integration";
  return (
    <SettingsScreen title={t(title)}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4 pb-12"
      >
        <IssuePicker
          label={t("Environment")}
          value={environment?.environmentId ?? ""}
          options={availableTargets.map((entry) => ({
            value: entry.environmentId,
            label: entry.label,
          }))}
          onChange={(value) => setSelected(EnvironmentId.make(value))}
        />
        {environment ? (
          section === "access" ? (
            <WechatSettingsSection
              key={environment.environmentId}
              environmentId={environment.environmentId}
            />
          ) : (
            <EnvironmentIntegration
              key={environment.environmentId}
              environment={environment}
              section={section}
            />
          )
        ) : (
          <Text>{t("No environment selected")}</Text>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function ServiceRow({
  toggle,
  ...props
}: ComponentProps<typeof SettingsRow> & {
  toggle?: { checked: boolean; disabled: boolean; onChange: (value: boolean) => void };
}) {
  const t = useUiTranslation();
  return (
    <View className="flex-row items-center">
      <View className="min-w-0 flex-1">
        <SettingsRow {...props} valuePosition="below" />
      </View>
      {toggle ? (
        <View className="pr-4">
          <ThemedSwitch
            accessibilityLabel={t("Enable {name}", { name: t(props.label) })}
            value={toggle.checked}
            disabled={toggle.disabled}
            onValueChange={toggle.onChange}
          />
        </View>
      ) : null}
    </View>
  );
}

function EnvironmentIntegration({
  environment,
  section,
}: {
  environment: SettingsTarget;
  section?: Exclude<Section, "access">;
}) {
  const t = useUiTranslation();
  const navigation = useNavigation();
  const environmentId = environment.environmentId;
  const settings =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId)) ??
    environment.serverConfig.settings;
  const enabled = settings.meituanIntegrationEnabled;
  const codeEnabled = isMeituanServiceEnabled(settings, "sourceControl");
  const issuesEnabled = isMeituanServiceEnabled(settings, "requirements");
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && !project.isScratch,
  );
  const associationsQuery = useEnvironmentQuery(
    issuesEnabled && shouldDiscoverMeituanProjectSources(section) && projects.length
      ? sourceControlEnvironment.issueSources({
          environmentId,
          input: { projectIds: projects.map((project) => project.id) },
        })
      : null,
  );
  const associatedProjectCount = projects.filter((project) => {
    const saved = (settings.issueProjectSources[project.id] ?? []).filter(
      (source) => source.provider === "meituan",
    );
    const automatic =
      associationsQuery.data
        ?.find((result) => result.projectId === project.id)
        ?.sources.filter((source) => source.provider === "meituan") ?? [];
    return mergeProjectIssueSources(automatic, saved).length > 0;
  }).length;
  const canToggle = environment.serverConfig.environment.capabilities.meituanIntegration === true;
  const needsLegacyRescan =
    environment.serverConfig.environment.capabilities.sourceControlToolMaintenance === true &&
    !environment.serverConfig.environment.capabilities.toolStatusFollowsSettings;
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [busy, setBusy] = useState(false);
  const skillQuery = useEnvironmentQuery(serverEnvironment.skills({ environmentId, input: {} }));
  const mutateSkills = useAtomCommand(serverEnvironment.mutateSkills);
  const skillsAllowed = useAtomValue(serverEnvironment.mutateSkills.permissionAtom(environmentId));
  const sources = skillQuery.data?.sources.filter((source) => source.kind === "mtskills") ?? [];
  const skillsEnabled = enabled && sources.some((source) => source.enabled);
  const activeToolIds = meituanToolIdsForSection(section, {
    code: codeEnabled,
    issues: issuesEnabled,
    skills: skillsEnabled,
  });
  const refreshTools = useAtomCommand(sourceControlEnvironment.refreshTools);
  const discovery = useEnvironmentQuery(
    codeEnabled ? sourceControlEnvironment.discovery({ environmentId, input: {} }) : null,
  );
  const item = discovery.data?.sourceControlProviders.find((entry) => entry.kind === "meituan");
  const current = { ...environment, serverConfig: { ...environment.serverConfig, settings } };
  const activeEnabled =
    section === "code"
      ? codeEnabled
      : section === "issues"
        ? issuesEnabled
        : section === "skills"
          ? skillsEnabled
          : enabled;
  const disabled = !activeEnabled || (section === "skills" ? !skillsAllowed : !allowed) || busy;
  const saveEnabled = async (value: boolean) => {
    setBusy(true);
    await update({ environmentId, input: { patch: { meituanIntegrationEnabled: value } } });
    setBusy(false);
    discovery.refresh();
    if (value && needsLegacyRescan) void refreshTools({ environmentId, input: {} });
  };
  const saveService = async (service: "code" | "issues" | "skills", value: boolean) => {
    if (
      !canToggle ||
      !enabled ||
      busy ||
      (service === "skills" ? !skillsAllowed || !skillQuery.data : !allowed)
    )
      return;
    setBusy(true);
    if (service === "skills") {
      const targets: ReadonlyArray<SkillSource> = sources.length
        ? sources
        : [
            {
              id: "meituan",
              label: t("Meituan Skills"),
              kind: "mtskills",
              enabled: false,
              executable: "mtskills",
              registry: "http://r.npm.sankuai.com",
            },
          ];
      await mutateSkills({
        environmentId,
        input: {
          type: "batch",
          operations: targets.map((source) => ({
            type: "source.save",
            source: { ...source, enabled: value },
          })),
        },
      });
      skillQuery.refresh();
    } else {
      await update({
        environmentId,
        input: {
          patch:
            service === "code"
              ? { meituanSourceControlEnabled: value }
              : { meituanRequirementsEnabled: value },
        },
      });
      discovery.refresh();
    }
    if (needsLegacyRescan) void refreshTools({ environmentId, input: {} });
    associationsQuery.refresh();
    setBusy(false);
  };
  const toggles = {
    code: {
      checked: settings.meituanSourceControlEnabled,
      disabled: !canToggle || !enabled || !allowed || busy,
      onChange: (value: boolean) => void saveService("code", value),
    },
    issues: {
      checked: settings.meituanRequirementsEnabled,
      disabled: !canToggle || !enabled || !allowed || busy,
      onChange: (value: boolean) => void saveService("issues", value),
    },
    skills: {
      checked: sources.some((source) => source.enabled),
      disabled: !canToggle || !enabled || !skillsAllowed || busy || !skillQuery.data,
      onChange: (value: boolean) => void saveService("skills", value),
    },
  };
  return (
    <>
      {!section ? (
        <SettingsSection>
          {canToggle ? (
            <SettingsSwitchRow
              label={t("Enable Meituan integration")}
              value={enabled}
              disabled={!allowed || busy}
              onValueChange={(value) => {
                if (value) void saveEnabled(true);
                else
                  Dialog.confirm({
                    title: t("Meituan integration"),
                    message: t(
                      "Pause Meituan integration on this environment? Saved settings and history are retained. WeChat, GitHub and local tasks are unaffected.",
                    ),
                    confirmText: t("Disable"),
                    destructive: true,
                    onConfirm: () => void saveEnabled(false),
                  });
              }}
            />
          ) : (
            <SettingsRow
              icon="cube"
              label={t("Meituan integration")}
              value={t("Server update required")}
            />
          )}
        </SettingsSection>
      ) : null}
      {section && section !== "daxiang" && canToggle ? (
        <SettingsSection>
          <SettingsSwitchRow
            label={t("Enable {name}", {
              name: t(
                section === "code"
                  ? "Source control"
                  : section === "issues"
                    ? "Requirements and delivery"
                    : "Meituan Skills",
              ),
            })}
            value={toggles[section].checked}
            disabled={toggles[section].disabled}
            onValueChange={toggles[section].onChange}
          />
        </SettingsSection>
      ) : null}
      {!activeEnabled ? (
        <Text accessibilityRole="text" className="px-2 text-sm text-foreground-muted">
          {t(
            section && enabled
              ? "This service is disabled. Saved settings are retained."
              : section
                ? "Meituan integration is paused. Saved settings are read-only."
                : "Automatic Meituan activity is paused. Saved settings and history are retained.",
          )}
        </Text>
      ) : null}
      {!section ? (
        <SettingsSection title={t("Service configuration")}>
          <ServiceRow
            icon="arrow.triangle.branch"
            label={t("Source control")}
            value={t(
              !enabled
                ? "Paused"
                : !codeEnabled
                  ? "Disabled"
                  : item?.auth.status === "authenticated"
                    ? "Authenticated"
                    : settings.sourceControlHosts.meituan?.mis
                      ? "Configuration retained"
                      : "Not authenticated",
            )}
            onPress={() => navigation.navigate("SettingsMeituanCode", { environmentId })}
            {...(canToggle ? { toggle: toggles.code } : {})}
          />
          <ServiceRow
            icon="ticket"
            label={t("Requirements and delivery")}
            value={
              !enabled
                ? t("Paused")
                : !issuesEnabled
                  ? t("Disabled")
                  : meituanAssociationCountLabel(
                      projects.length,
                      associationsQuery,
                      associatedProjectCount,
                      t,
                    )
            }
            onPress={() => navigation.navigate("SettingsMeituanIssues", { environmentId })}
            {...(canToggle ? { toggle: toggles.issues } : {})}
          />
          <ServiceRow
            icon="bubble.left.and.bubble.right"
            label="DaXiang"
            value={t(
              !enabled
                ? "Paused"
                : settings.daxiang.clientId && settings.daxiang.clientSecret
                  ? "Configured"
                  : "Not configured",
            )}
            onPress={() => navigation.navigate("SettingsMeituanDaxiang", { environmentId })}
          />
          <ServiceRow
            icon="doc.text"
            label={t("Meituan Skills")}
            value={t(!enabled ? "Paused" : skillsEnabled ? "Enabled" : "Disabled")}
            onPress={() => navigation.navigate("SettingsMeituanSkills", { environmentId })}
            {...(canToggle ? { toggle: toggles.skills } : {})}
          />
        </SettingsSection>
      ) : section === "code" ? (
        <>
          <MeituanCodeSettingsSection
            environment={current}
            disabled={disabled}
            multiple={false}
            initialExpanded
          />
        </>
      ) : section === "issues" ? (
        <SettingsSection title={t("Project associations")}>
          <View className="p-4">
            <ProjectSources
              environmentId={environmentId}
              providerOnly="meituan"
              disabled={disabled}
            />
          </View>
        </SettingsSection>
      ) : section === "daxiang" ? (
        <DaxiangSettingsSection environmentId={environmentId} disabled={disabled} />
      ) : (
        <MeituanSkillSource environmentId={environmentId} disabled={disabled} />
      )}
      {activeEnabled && activeToolIds.length ? (
        <SourceControlToolsSection environment={current} only={activeToolIds} />
      ) : null}
    </>
  );
}

function MeituanSkillSource({
  environmentId,
  disabled,
}: {
  environmentId: EnvironmentId;
  disabled: boolean;
}) {
  const t = useUiTranslation();
  const query = useEnvironmentQuery(serverEnvironment.skills({ environmentId, input: {} }));
  const mutate = useAtomCommand(serverEnvironment.mutateSkills);
  const allowed = useAtomValue(serverEnvironment.mutateSkills.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const sources = query.data?.sources.filter((entry) => entry.kind === "mtskills");
  const source: SkillSource = sources?.find((entry) => entry.enabled) ??
    sources?.[0] ?? {
      id: "meituan",
      label: t("Meituan Skills"),
      kind: "mtskills",
      enabled: false,
      executable: "mtskills",
      registry: "http://r.npm.sankuai.com",
    };
  const run = async (input: Parameters<typeof mutate>[0]["input"]) => {
    setBusy(true);
    await mutate({ environmentId, input });
    setBusy(false);
    query.refresh();
  };
  return (
    <SettingsSection title={t("Meituan Skills")}>
      <View className="gap-4 p-4">
        <Text className="text-sm text-foreground-muted">{source.registry}</Text>
        <Text className="font-mono text-sm text-foreground-muted">
          {source.executable || "mtskills"}
        </Text>
        <Button
          label={t("Prepare installer")}
          disabled={
            disabled ||
            !allowed ||
            busy ||
            !query.data?.sources.some((entry) => entry.id === source.id)
          }
          loading={busy}
          onPress={() => void run({ type: "source.prepare", sourceId: source.id })}
        />
      </View>
    </SettingsSection>
  );
}

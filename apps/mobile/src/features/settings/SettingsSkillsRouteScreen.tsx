import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Switch, TextInput, View } from "react-native";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ManagedSkill,
  type SkillMutation,
  type SkillSnapshot,
  type SkillUpdatePolicy,
} from "@t3tools/contracts";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const policies: Record<SkillUpdatePolicy, string> = {
  manual: "Manual",
  notify: "Check daily",
  automatic: "Update daily",
  pinned: "Pinned",
};
type Mutate = (input: SkillMutation) => Promise<boolean>;

function Policy({
  value,
  disabled,
  onChange,
}: {
  value: SkillUpdatePolicy;
  disabled: boolean;
  onChange: (value: SkillUpdatePolicy) => void;
}) {
  return (
    <Menu
      actions={Object.entries(policies).map(([id, title]) => ({
        id,
        title,
        attributes: { disabled },
      }))}
      onPressAction={({ nativeEvent }) => {
        const selected = Object.keys(policies).find((key) => key === nativeEvent.event) as
          | SkillUpdatePolicy
          | undefined;
        if (selected && !disabled) onChange(selected);
      }}
    >
      <ControlPill label={policies[value]} accessibilityLabel="Update policy" disabled={disabled} />
    </Menu>
  );
}

function TargetSelection({
  data,
  selected,
  disabled,
  onChange,
}: {
  data: SkillSnapshot;
  selected: ReadonlyArray<string>;
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  return (
    <View className="gap-3">
      {data.targets.map((target) => (
        <View key={target.id} className="flex-row items-center gap-3">
          <View className="min-w-0 flex-1">
            <Text className="text-foreground">{target.label}</Text>
            <Text className="text-xs text-foreground-muted">{target.directory}</Text>
          </View>
          <Switch
            accessibilityLabel={target.label}
            value={selected.includes(target.id)}
            disabled={disabled}
            onValueChange={(enabled) =>
              onChange(
                enabled ? [...selected, target.id] : selected.filter((id) => id !== target.id),
              )
            }
          />
        </View>
      ))}
    </View>
  );
}

function Skill({
  skill,
  data,
  disabled,
  mutate,
}: {
  skill: ManagedSkill;
  data: SkillSnapshot;
  disabled: boolean;
  mutate: Mutate;
}) {
  const [expanded, setExpanded] = useState(false);
  const displayName = skill.description ? skill.name : skill.requestedSkill || skill.locator;
  const configure = (targetIds: ReadonlyArray<string>, policy = skill.policy) =>
    void mutate({ type: "configure", id: skill.id, targetIds, policy });
  return (
    <View className="gap-3 border-t border-border-subtle p-4">
      <View className="flex-row items-start gap-3">
        <View className="min-w-0 flex-1">
          <Text className="font-semibold text-foreground">{displayName}</Text>
          <Text numberOfLines={2} className="text-sm text-foreground-muted">
            {skill.description}
          </Text>
        </View>
        <Text className="max-w-32 rounded border border-border-subtle px-2 py-1 text-xs text-foreground-muted">
          {skill.sourceLabel}
        </Text>
      </View>
      <Text className="text-xs text-foreground-muted">
        {skill.status === "pending" ? "Waiting for idle agents" : skill.status} ·{" "}
        {skill.bindings.filter((target) => target.status === "linked").length}/
        {skill.bindings.length} linked{skill.availableDigest ? " · Update available" : ""}
      </Text>
      {skill.failure ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {skill.failure}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <ControlPill
          icon="arrow.clockwise"
          accessibilityLabel={`Check updates for ${displayName}`}
          disabled={disabled}
          onPress={() => void mutate({ type: "check", id: skill.id })}
        />
        <ControlPill
          icon="arrow.down"
          accessibilityLabel={`Update ${displayName}`}
          disabled={disabled}
          onPress={() => void mutate({ type: "update", id: skill.id })}
        />
        <ControlPill
          icon="trash"
          accessibilityLabel={`Remove ${displayName}`}
          disabled={disabled}
          onPress={() =>
            Dialog.alert("Remove skill?", displayName, [
              { text: "Cancel", style: "cancel" },
              {
                text: "Remove",
                style: "destructive",
                onPress: () => void mutate({ type: "remove", id: skill.id }),
              },
            ])
          }
        />
        <ControlPill
          icon={expanded ? "chevron.up" : "chevron.down"}
          accessibilityLabel={`${expanded ? "Hide" : "Show"} skill details`}
          onPress={() => setExpanded(!expanded)}
        />
      </View>
      {expanded ? (
        <View className="gap-3">
          <Text selectable className="text-xs text-foreground-muted">
            {skill.locator}
          </Text>
          <Policy
            value={skill.policy}
            disabled={disabled}
            onChange={(policy) =>
              configure(
                skill.bindings.map((target) => target.id),
                policy,
              )
            }
          />
          <TargetSelection
            data={data}
            selected={skill.bindings.map((target) => target.id)}
            disabled={disabled}
            onChange={(ids) => configure(ids)}
          />
          {skill.bindings
            .filter((target) => target.status !== "linked")
            .map((target) => (
              <Text key={target.id} className="text-danger-foreground">
                {target.label}: {target.status}
              </Text>
            ))}
          {[...skill.versions].reverse().map((version) => (
            <View key={version.digest} className="flex-row items-center justify-between gap-3">
              <Text className="font-mono text-xs text-foreground-muted">
                {version.digest.slice(0, 12)}
              </Text>
              {version.digest === skill.activeDigest ? (
                <Text className="text-xs text-foreground-muted">Active</Text>
              ) : (
                <ControlPill
                  icon="arrow.uturn.backward"
                  accessibilityLabel={`Restore ${version.digest.slice(0, 12)}`}
                  disabled={disabled}
                  onPress={() =>
                    void mutate({ type: "rollback", id: skill.id, digest: version.digest })
                  }
                />
              )}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Install({
  data,
  disabled,
  mutate,
  onClose,
}: {
  data: SkillSnapshot;
  disabled: boolean;
  mutate: Mutate;
  onClose: () => void;
}) {
  const [sourceId, setSourceId] = useState(data.sources.find((source) => source.enabled)?.id ?? "");
  const [locator, setLocator] = useState("");
  const [name, setName] = useState("");
  const [targets, setTargets] = useState<string[]>([]);
  const [policy, setPolicy] = useState<SkillUpdatePolicy>("manual");
  return (
    <View className="gap-4 border-t border-border-subtle p-4">
      <Menu
        actions={data.sources
          .filter((source) => source.enabled)
          .map((source) => ({ id: source.id, title: source.label }))}
        onPressAction={({ nativeEvent }) => setSourceId(nativeEvent.event)}
      >
        <ControlPill
          label={data.sources.find((source) => source.id === sourceId)?.label ?? "Source"}
          accessibilityLabel="Skill source"
        />
      </Menu>
      <TextInput
        accessibilityLabel="Skill location"
        className="rounded-lg border border-border-subtle px-3 py-2 text-foreground"
        placeholder="Skill directory, repository or identifier"
        placeholderTextColorClassName="accent-foreground-muted"
        autoCapitalize="none"
        autoCorrect={false}
        value={locator}
        onChangeText={setLocator}
      />
      <TextInput
        accessibilityLabel="Skill name"
        className="rounded-lg border border-border-subtle px-3 py-2 text-foreground"
        placeholder="Skill name / market ID (optional)"
        placeholderTextColorClassName="accent-foreground-muted"
        autoCapitalize="none"
        autoCorrect={false}
        value={name}
        onChangeText={setName}
      />
      <Policy value={policy} disabled={disabled} onChange={setPolicy} />
      <TargetSelection data={data} selected={targets} disabled={disabled} onChange={setTargets} />
      <View className="flex-row gap-3">
        <ControlPill label="Cancel" onPress={onClose} />
        <ControlPill
          variant="primary"
          label="Install"
          disabled={disabled || !sourceId || !locator.trim()}
          onPress={() =>
            void mutate({
              type: "install",
              sourceId,
              locator: locator.trim(),
              skill: name.trim(),
              targetIds: targets,
              policy,
            }).then((accepted) => {
              if (accepted) onClose();
            })
          }
        />
      </View>
    </View>
  );
}

function EnvironmentSkills({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(serverEnvironment.skills({ environmentId, input: {} }));
  const permitted = useAtomValue(serverEnvironment.mutateSkills.permissionAtom(environmentId));
  const command = useAtomCommand(serverEnvironment.mutateSkills);
  const [installing, setInstalling] = useState(false);
  const [sources, setSources] = useState(false);
  const mutate: Mutate = async (input) =>
    (await command({ environmentId, input }))._tag === "Success";
  const data = query.data;
  if (query.error)
    return (
      <Text accessibilityRole="alert" className="p-4 text-danger-foreground">
        {query.error}
      </Text>
    );
  if (!data) return <Text className="p-4 text-foreground-muted">Loading skills...</Text>;
  const disabled = !permitted || data.operation !== null;
  return (
    <>
      <View className="flex-row flex-wrap gap-3 p-4">
        <ControlPill
          label="Install skill"
          icon="plus"
          disabled={disabled}
          onPress={() => setInstalling(true)}
        />
        <ControlPill label="Sources" onPress={() => setSources(!sources)} />
      </View>
      {data.operation ? (
        <Text accessibilityLiveRegion="polite" className="px-4 text-foreground-muted">
          {data.operation === "source.prepare"
            ? "Preparing installer..."
            : "Applying skill changes..."}
        </Text>
      ) : null}
      {data.lastFailure ? (
        <Text accessibilityRole="alert" className="px-4 text-danger-foreground">
          {data.lastFailure}
        </Text>
      ) : null}
      {installing ? (
        <Install
          data={data}
          disabled={disabled}
          mutate={mutate}
          onClose={() => setInstalling(false)}
        />
      ) : null}
      {sources
        ? data.sources.map((source) => (
            <View key={source.id} className="gap-3 border-t border-border-subtle p-4">
              <View className="flex-row items-center gap-3">
                <Text className="flex-1 text-foreground">{source.label}</Text>
                <Switch
                  accessibilityLabel={`Enable ${source.label}`}
                  disabled={disabled}
                  value={source.enabled}
                  onValueChange={(enabled) =>
                    void mutate({ type: "source.save", source: { ...source, enabled } })
                  }
                />
              </View>
              {source.kind !== "local" ? (
                <ControlPill
                  icon="arrow.down"
                  label="Prepare installer"
                  disabled={disabled}
                  onPress={() => void mutate({ type: "source.prepare", sourceId: source.id })}
                />
              ) : null}
            </View>
          ))
        : null}
      {data.skills.length === 0 ? (
        <Text className="p-4 text-foreground-muted">No managed skills installed</Text>
      ) : null}
      {data.skills.map((skill) => (
        <Skill key={skill.id} skill={skill} data={data} disabled={disabled} mutate={mutate} />
      ))}
    </>
  );
}

export function SettingsSkillsRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const permitted = useEnvironmentsWithScope(selectedTargets, AuthProvidersManageScope);
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Skills" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4 pb-12"
        >
          {selectedTargets.map((environment) => (
            <SettingsSection key={environment.environmentId} title={environment.label}>
              {permitted.has(environment.environmentId) ? (
                <EnvironmentSkills environmentId={environment.environmentId} />
              ) : (
                <Text className="p-4 text-foreground-muted">
                  Provider management permission required
                </Text>
              )}
            </SettingsSection>
          ))}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

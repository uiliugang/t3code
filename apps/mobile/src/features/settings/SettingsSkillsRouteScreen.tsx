import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Switch, TextInput, View } from "react-native";
import {
  skillFailureMessage,
  type DiscoveredSkill,
  type EnvironmentId,
  type ManagedSkill,
  type SkillInspect,
  type SkillInspection,
  type SkillMutation,
  type SkillSnapshot,
  type SkillSource,
  type SkillUpdatePolicy,
} from "@t3tools/contracts";
import {
  skillPolicies,
  skillJobNames,
  skillFilters,
  skillRows,
  skillStatus,
  skillFailure,
  skillNextCheck,
  skillSourceName,
  type SkillFilter,
} from "@t3tools/shared/skillsUi";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { mobilePreferencesAtom } from "../../state/preferences";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

type Mutate = (input: SkillMutation) => Promise<boolean>;
type Inspect = (input: SkillInspect) => Promise<SkillInspection | null>;
function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <View className="gap-1">
      <Text className="text-xs text-foreground-muted">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        className="rounded-lg border border-border-subtle px-3 py-2 text-foreground"
        autoCapitalize="none"
        autoCorrect={false}
        value={value}
        onChangeText={onChange}
      />
    </View>
  );
}
function SkillDate({ value }: { value: string | null }) {
  const t = useUiTranslation();
  const prefs = useAtomValue(mobilePreferencesAtom);
  const locale = AsyncResult.isSuccess(prefs) ? (prefs.value.uiLanguage ?? "en") : "en";
  return (
    <Text className="text-xs text-foreground-muted">
      {value ? new Date(value).toLocaleString(locale) : t("Not scheduled")}
    </Text>
  );
}
function Policy({
  value,
  disabled,
  onChange,
}: {
  value: SkillUpdatePolicy;
  disabled: boolean;
  onChange: (value: SkillUpdatePolicy) => void;
}) {
  const t = useUiTranslation();
  return (
    <Menu
      actions={Object.entries(skillPolicies)
        .filter(([id]) => id !== "manual")
        .map(([id, title]) => ({
          id,
          title: t(title),
          attributes: { disabled },
        }))}
      onPressAction={({ nativeEvent }) => {
        const policy = Object.keys(skillPolicies).find((key) => key === nativeEvent.event) as
          | SkillUpdatePolicy
          | undefined;
        if (policy && !disabled) onChange(policy);
      }}
    >
      <ControlPill
        label={t(skillPolicies[value])}
        accessibilityLabel={t("Update policy")}
        disabled={disabled}
      />
    </Menu>
  );
}
function SourcesMenu({
  data,
  value,
  onChange,
}: {
  data: SkillSnapshot;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useUiTranslation();
  const source = data.sources.find((entry) => entry.id === value);
  return (
    <Menu
      actions={data.sources.map((entry) => ({ id: entry.id, title: skillSourceName(entry, t) }))}
      onPressAction={({ nativeEvent }) => onChange(nativeEvent.event)}
    >
      <ControlPill
        label={source ? skillSourceName(source, t) : t("Choose source")}
        accessibilityLabel={t("Skill source")}
      />
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
  const t = useUiTranslation();
  return (
    <View className="gap-3">
      {data.targets.map((target) => (
        <View key={target.id} className="flex-row items-center gap-3">
          <View className="min-w-0 flex-1">
            <Text className="text-foreground">
              {target.id === "directory:shared" ? t("Shared skills") : target.label}
            </Text>
            <Text selectable className="text-xs text-foreground-muted">
              {target.directory}
            </Text>
          </View>
          <Switch
            accessibilityLabel={
              target.id === "directory:shared" ? t("Shared skills") : target.label
            }
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
function Install({
  data,
  disabled,
  mutate,
  onClose,
  existing,
}: {
  data: SkillSnapshot;
  disabled: boolean;
  mutate: Mutate;
  onClose: () => void;
  existing?: ManagedSkill;
}) {
  const t = useUiTranslation();
  const [sourceId, setSourceId] = useState(
    existing?.sourceId ?? data.sources.find((source) => source.enabled)?.id ?? "",
  );
  const [locator, setLocator] = useState(
    existing && !existing.snapshotOnly ? existing.locator : "",
  );
  const [name, setName] = useState(existing?.requestedSkill ?? "");
  const [targets, setTargets] = useState<string[]>([]);
  const [policy, setPolicy] = useState<SkillUpdatePolicy>("automatic");
  const [advanced, setAdvanced] = useState(false);
  return (
    <View className="gap-4 border-t border-border-subtle p-4">
      <Text className="font-semibold text-foreground">
        {t(existing ? "Connect update source" : "Install skill")}
      </Text>
      <SourcesMenu data={data} value={sourceId} onChange={setSourceId} />
      <Field label={t("Skill location")} value={locator} onChange={setLocator} />
      <Field label={t("Skill name (optional)")} value={name} onChange={setName} />
      <Text className="text-xs text-foreground-muted">
        {t("Paths and credentials belong to the selected environment.")}
      </Text>
      {!existing && (
        <>
          <Text className="text-foreground">{t("Automatic updates by default")}</Text>
          <Text className="text-xs text-foreground-muted">
            {t(
              "Checks daily and applies changes when agents are idle. No confirmation is needed for each update.",
            )}
          </Text>
          <ControlPill label={t("Advanced options")} onPress={() => setAdvanced(!advanced)} />
          {advanced && <Policy value={policy} disabled={disabled} onChange={setPolicy} />}
          <TargetSelection
            data={data}
            selected={targets}
            disabled={disabled}
            onChange={setTargets}
          />
          {!targets.length && (
            <Text className="text-xs text-foreground-muted">
              {t("Saved to the library only. Assign a location when you want an agent to use it.")}
            </Text>
          )}
        </>
      )}
      <View className="flex-row flex-wrap gap-2">
        <ControlPill label={t("Cancel")} onPress={onClose} />
        <ControlPill
          variant="primary"
          label={t(existing ? "Save source" : targets.length ? "Install" : "Save to library")}
          disabled={
            disabled ||
            !locator.trim() ||
            !data.sources.find((source) => source.id === sourceId)?.enabled
          }
          onPress={() => {
            const action: SkillMutation = existing
              ? {
                  type: "origin",
                  id: existing.id,
                  sourceId,
                  locator: locator.trim(),
                  skill: name.trim(),
                }
              : {
                  type: "install",
                  sourceId,
                  locator: locator.trim(),
                  skill: name.trim(),
                  targetIds: targets,
                  ...(policy !== "automatic" ? { policy } : {}),
                };
            void mutate(action).then((ok) => {
              if (ok) onClose();
            });
          }}
        />
      </View>
    </View>
  );
}
function Skill({
  skill,
  data,
  disabled,
  mutate,
  inspect,
}: {
  skill: ManagedSkill;
  data: SkillSnapshot;
  disabled: boolean;
  mutate: Mutate;
  inspect: Inspect;
}) {
  const t = useUiTranslation();
  const [expanded, setExpanded] = useState(false);
  const [origin, setOrigin] = useState(false);
  const [inspection, setInspection] = useState<SkillInspection | null>(null);
  const name = skill.description ? skill.name : skill.requestedSkill || skill.locator;
  const failure = skillFailure(skill);
  const confirm = (label: string, action: SkillMutation) =>
    Dialog.alert(label, name, [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Continue"), onPress: () => void mutate(action) },
    ]);
  return (
    <View className="gap-3 border-t border-border-subtle py-4">
      <Text className="font-semibold text-foreground">{name}</Text>
      <Text numberOfLines={expanded ? undefined : 1} className="text-sm text-foreground-muted">
        {skill.description}
      </Text>
      <Text className="text-xs text-foreground-muted">
        {t(skillStatus(skill))} · {t(skillPolicies[skill.policy])}
      </Text>
      <Text className="text-xs text-foreground-muted">
        {t("{linked}/{total} locations linked", {
          linked: skill.bindings.filter((target) => target.status === "linked").length,
          total: skill.bindings.length,
        })}
      </Text>
      {skill.bindings.map((target) => (
        <Text key={target.id} selectable className="text-xs text-foreground-muted">
          {target.id === "directory:shared" ? t("Shared skills") : target.label} ·{" "}
          {target.directory}/{target.entryName ?? skill.name}
        </Text>
      ))}
      {failure && (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {t(failure)}
        </Text>
      )}
      <View className="flex-row flex-wrap gap-2">
        <ControlPill label={t("Details")} onPress={() => setExpanded(!expanded)} />
        {(skill.availableDigest || skill.failureReason === "local-changes") && (
          <ControlPill
            label={t("Review update")}
            disabled={disabled}
            onPress={() => void inspect({ type: "diff", id: skill.id }).then(setInspection)}
          />
        )}
        {skill.status === "pending" && (
          <ControlPill
            label={t("Cancel pending update")}
            disabled={disabled}
            onPress={() => void mutate({ type: "cancel", id: skill.id })}
          />
        )}
      </View>
      {inspection && (
        <View className="gap-3">
          <Text className="text-foreground">
            {t("Current {current} → candidate {candidate}", {
              current: inspection.digest.slice(0, 12),
              candidate: inspection.candidateDigest?.slice(0, 12) ?? t("None"),
            })}
          </Text>
          {inspection.files
            .filter((file) => file.status !== "unchanged")
            .map((file) => (
              <View key={file.path} className="gap-1">
                <Text className="text-foreground">{file.path}</Text>
                <Text selectable className="text-xs text-foreground-muted">
                  {t("Current files")}: {file.before || t("Text preview unavailable")}
                </Text>
                <Text selectable className="text-xs text-foreground-muted">
                  {t("Candidate files")}: {file.after || t("Text preview unavailable")}
                </Text>
              </View>
            ))}
          {inspection.truncated && (
            <Text className="text-xs text-foreground-muted">
              {t("Large or binary files are listed without a text preview.")}
            </Text>
          )}
          <View className="flex-row flex-wrap gap-2">
            {skill.failureReason === "local-changes" && (
              <ControlPill
                label={t("Keep local changes and pin")}
                disabled={disabled}
                onPress={() =>
                  void mutate({
                    type: "resolve",
                    id: skill.id,
                    resolution: "keep",
                    digest: inspection.digest,
                  }).then(() => setInspection(null))
                }
              />
            )}
            <ControlPill
              label={t("Use candidate version")}
              disabled={disabled || !inspection.candidateDigest || skill.policy === "pinned"}
              onPress={() =>
                void mutate({
                  type: "resolve",
                  id: skill.id,
                  resolution: "upstream",
                  digest: inspection.candidateDigest!,
                }).then(() => setInspection(null))
              }
            />
            <ControlPill label={t("Close")} onPress={() => setInspection(null)} />
          </View>
        </View>
      )}
      {expanded && (
        <View className="gap-3">
          <Text className="text-xs text-foreground-muted">
            {t(
              "Files are managed on this environment. Start a new session or reload the provider to use changed files.",
            )}
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            {skill.locator}
          </Text>
          <Text className="text-xs text-foreground-muted">{t("Last check")}</Text>
          <SkillDate value={skill.checkedAt} />
          <Text className="text-xs text-foreground-muted">{t("Next check")}</Text>
          <SkillDate value={skillNextCheck(skill)} />
          <Policy
            value={skill.policy}
            disabled={disabled}
            onChange={(policy) => void mutate({ type: "policy", id: skill.id, policy })}
          />
          {skill.policyOrigin === "legacy" && (
            <Text className="text-xs text-foreground-muted">
              {t("Existing policy kept. Choose a policy to confirm your preference.")}
            </Text>
          )}
          <View className="flex-row flex-wrap gap-2">
            <ControlPill
              label={t("Check updates")}
              disabled={disabled}
              onPress={() => void mutate({ type: "check", id: skill.id })}
            />
            <ControlPill
              label={t("Connect update source")}
              disabled={disabled}
              onPress={() => setOrigin(!origin)}
            />
          </View>
          {origin && (
            <Install
              data={data}
              disabled={disabled}
              mutate={mutate}
              onClose={() => setOrigin(false)}
              existing={skill}
            />
          )}
          {skill.choices?.map((choice) => (
            <ControlPill
              key={choice}
              label={choice}
              disabled={disabled}
              onPress={() => void mutate({ type: "select", id: skill.id, skill: choice })}
            />
          ))}
          <TargetSelection
            data={data}
            selected={skill.bindings.map((target) => target.id)}
            disabled={disabled}
            onChange={(targetIds) =>
              void mutate({ type: "configure", id: skill.id, targetIds, policy: skill.policy })
            }
          />
          {skill.bindings
            .filter((target) => target.status !== "linked")
            .map((target) => (
              <Text key={target.id} className="text-danger-foreground">
                {target.label}: {t(target.status === "conflict" ? "Conflict" : "Missing")}
              </Text>
            ))}
          <Text className="font-semibold text-foreground">{t("Version history")}</Text>
          {[...skill.versions].reverse().map((version) => (
            <View key={version.digest} className="flex-row items-center justify-between gap-3">
              <Text className="font-mono text-xs text-foreground-muted">
                {version.label ?? version.digest.slice(0, 12)}
              </Text>
              {version.digest === skill.activeDigest ? (
                <Text className="text-xs text-foreground-muted">{t("Current")}</Text>
              ) : (
                <ControlPill
                  label={t("Restore and pin")}
                  disabled={disabled}
                  onPress={() =>
                    void mutate({ type: "rollback", id: skill.id, digest: version.digest })
                  }
                />
              )}
            </View>
          ))}
          <View className="flex-row flex-wrap gap-2">
            <ControlPill
              label={t("Stop managing, keep files")}
              disabled={disabled}
              onPress={() =>
                confirm(
                  t("Stop managing {name} and keep its files at the linked locations?", { name }),
                  { type: "unmanage", id: skill.id, restore: false },
                )
              }
            />
            {Boolean(skill.backups?.length) && (
              <ControlPill
                label={t("Restore original locations")}
                disabled={disabled}
                onPress={() =>
                  confirm(
                    t("Restore the original locations of {name} and stop managing it?", { name }),
                    { type: "unmanage", id: skill.id, restore: true },
                  )
                }
              />
            )}
            <ControlPill
              label={t("Uninstall")}
              disabled={disabled}
              onPress={() =>
                confirm(
                  t(
                    "Uninstall {name} and its managed links? Original adoption backups will be restored.",
                    { name },
                  ),
                  { type: "remove", id: skill.id },
                )
              }
            />
          </View>
        </View>
      )}
    </View>
  );
}
function Source({
  source,
  mutate,
  disabled,
}: {
  source: SkillSource;
  mutate: Mutate;
  disabled: boolean;
}) {
  const t = useUiTranslation();
  const [draft, setDraft] = useState(source);
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="gap-3 border-t border-border-subtle py-4">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-foreground">{skillSourceName(source, t)}</Text>
        <Switch
          accessibilityLabel={t("Enable {name}", { name: skillSourceName(source, t) })}
          disabled={disabled}
          value={source.enabled}
          onValueChange={(enabled) =>
            void mutate({ type: "source.save", source: { ...source, enabled } })
          }
        />
      </View>
      <Text className="text-xs text-foreground-muted">
        {source.health
          ? t(
              source.health.reason
                ? skillFailureMessage(source.health.reason)
                : source.health.detail,
            )
          : t("Not checked")}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        <ControlPill
          label={t("Check availability")}
          disabled={disabled}
          onPress={() => void mutate({ type: "source.check", sourceId: source.id })}
        />
        <ControlPill label={t("Configuration")} onPress={() => setExpanded(!expanded)} />
      </View>
      {expanded && (
        <>
          <Field
            label={t("Source label")}
            value={draft.label}
            onChange={(label) => setDraft({ ...draft, label })}
          />
          {source.kind !== "local" && (
            <>
              <Field
                label={t("Installer executable")}
                value={draft.executable}
                onChange={(executable) => setDraft({ ...draft, executable })}
              />
              <Field
                label={t("npm registry")}
                value={draft.registry}
                onChange={(registry) => setDraft({ ...draft, registry })}
              />
              <ControlPill
                label={t("Prepare installer")}
                disabled={disabled}
                onPress={() => void mutate({ type: "source.prepare", sourceId: source.id })}
              />
            </>
          )}
          <ControlPill
            label={t("Save source")}
            disabled={disabled}
            onPress={() =>
              void mutate({ type: "source.save", source: { ...draft, enabled: source.enabled } })
            }
          />
          <ControlPill
            label={t("Remove source")}
            disabled={disabled}
            onPress={() =>
              Dialog.alert(t("Remove source"), source.label, [
                { text: t("Cancel"), style: "cancel" },
                {
                  text: t("Remove"),
                  style: "destructive",
                  onPress: () => void mutate({ type: "source.remove", sourceId: source.id }),
                },
              ])
            }
          />
        </>
      )}
    </View>
  );
}
function EnvironmentSkills({ environmentId }: { environmentId: EnvironmentId }) {
  const t = useUiTranslation();
  const query = useEnvironmentQuery(serverEnvironment.skills({ environmentId, input: {} }));
  const permitted = useAtomValue(serverEnvironment.mutateSkills.permissionAtom(environmentId));
  const command = useAtomCommand(serverEnvironment.mutateSkills);
  const inspector = useAtomCommand(serverEnvironment.inspectSkills);
  const [tab, setTab] = useState("skills");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const [previews, setPreviews] = useState<
    Array<{ skill: DiscoveredSkill; preview: SkillInspection }>
  >([]);
  const [locations, setLocations] = useState<Record<string, string[]>>({});
  const [previewError, setPreviewError] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [directory, setDirectory] = useState("");
  const [label, setLabel] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [sourceKind, setSourceKind] = useState<SkillSource["kind"]>("skills");
  const [history, setHistory] = useState(false);
  const mutate: Mutate = async (input) =>
    (await command({ environmentId, input }))._tag === "Success";
  const inspect: Inspect = async (input) => {
    const result = await inspector({ environmentId, input });
    return result._tag === "Success" ? result.value : null;
  };
  const preview = async (skills: DiscoveredSkill[]) => {
    setPreviewing(true);
    const results = [];
    for (const skill of skills) {
      const result = await inspect({ type: "adopt", path: skill.path });
      if (result) results.push({ skill, preview: result });
    }
    setLocations(
      Object.fromEntries(results.map(({ skill }) => [skill.path, [...(skill.targetIds ?? [])]])),
    );
    setPreviewError(results.length !== skills.length);
    setPreviews(results);
    setPreviewing(false);
  };
  const data = query.data;
  if (!data)
    return (
      <Text
        accessibilityRole={query.error ? "alert" : undefined}
        className="p-4 text-foreground-muted"
      >
        {t(
          query.error
            ? "Skills could not be loaded. Reconnect the environment and retry."
            : "Loading skills...",
        )}
      </Text>
    );
  const disabled = !permitted;
  const { rows, counts } = skillRows(data, search, filter);
  const chosen = data.skills.filter((skill) => selected.includes(skill.id));
  const discovered = data.discovered.filter(
    (skill) => selected.includes(skill.identity ?? skill.path) && !skill.external,
  );
  return (
    <View className="gap-3 p-4">
      <Text className="text-xs text-foreground-muted">{t("Checks for updates once a day")}</Text>
      {disabled && (
        <Text className="text-foreground-muted">
          {t("Read-only access. Full access is required to manage skills.")}
        </Text>
      )}
      <View className="flex-row flex-wrap gap-2">
        <ControlPill
          label={t("Install skill")}
          disabled={disabled}
          onPress={() => setInstalling(!installing)}
        />
        <ControlPill
          label={t("Refresh discoveries")}
          disabled={disabled}
          onPress={() => void mutate({ type: "refresh" })}
        />
      </View>
      <Menu
        actions={[
          { id: "skills", title: t("Skills list") },
          { id: "sources", title: t("Installation sources") },
          { id: "targets", title: t("Usage locations") },
        ]}
        onPressAction={({ nativeEvent }) => setTab(nativeEvent.event)}
      >
        <ControlPill
          label={t(
            tab === "skills"
              ? "Skills list"
              : tab === "sources"
                ? "Installation sources"
                : "Usage locations",
          )}
        />
      </Menu>
      {data.lastFailure && (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {t(
            data.lastFailureReason ? skillFailureMessage(data.lastFailureReason) : data.lastFailure,
          )}
        </Text>
      )}
      {installing && (
        <Install
          data={data}
          disabled={disabled}
          mutate={mutate}
          onClose={() => setInstalling(false)}
        />
      )}
      {previewError && (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {t("Some skills could not be previewed. Refresh discoveries and try again.")}
        </Text>
      )}
      {previews.length > 0 && (
        <View className="gap-3 border-t border-border-subtle py-4">
          <Text className="font-semibold text-foreground">{t("Review adoption")}</Text>
          {previews.map(({ skill, preview: item }) => (
            <View key={skill.path} className="gap-1">
              <Text className="text-foreground">
                {skill.name} · {item.digest.slice(0, 12)}
              </Text>
              <Text selectable className="text-xs text-foreground-muted">
                {skill.path}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {item.origin
                  ? `${item.origin.locator} · ${item.origin.evidence}`
                  : t(
                      "Source unknown. A takeover is saved as a local snapshot until a source is connected.",
                    )}
              </Text>
              <TargetSelection
                data={{
                  ...data,
                  targets: data.targets.filter((target) => skill.targetIds?.includes(target.id)),
                }}
                selected={locations[skill.path] ?? []}
                disabled={disabled}
                onChange={(ids) => setLocations((current) => ({ ...current, [skill.path]: ids }))}
              />
            </View>
          ))}
          <Text className="text-xs text-foreground-muted">
            {t(
              "Original locations are backed up before switching to managed files. You can restore them when stopping management.",
            )}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {(["copy", "takeover"] as const).map((mode) => (
              <ControlPill
                key={mode}
                label={t(mode === "copy" ? "Copy to library" : "Take over selected locations")}
                disabled={
                  disabled ||
                  (mode === "takeover" &&
                    previews.some(({ skill }) => !locations[skill.path]?.length))
                }
                onPress={() =>
                  void mutate({
                    type: "batch",
                    operations: previews
                      .filter((item) => !item.preview.external)
                      .map(({ skill, preview: item }) => ({
                        type: "adopt",
                        path: skill.path,
                        digest: item.digest,
                        mode,
                        targetIds: mode === "takeover" ? (locations[skill.path] ?? []) : [],
                        ...(item.origin ? { origin: item.origin } : {}),
                      })),
                  }).then((ok) => {
                    if (ok) {
                      setPreviews([]);
                      setSelected([]);
                    }
                  })
                }
              />
            ))}
            <ControlPill label={t("Cancel")} onPress={() => setPreviews([])} />
          </View>
        </View>
      )}
      {tab === "skills" && (
        <>
          {counts.all > 0 && (
            <>
              <Field label={t("Search skills")} value={search} onChange={setSearch} />
              <Menu
                actions={Object.entries(skillFilters).map(([id, title]) => ({
                  id,
                  title: `${t(title)} (${counts[id as SkillFilter]})`,
                }))}
                onPressAction={({ nativeEvent }) => setFilter(nativeEvent.event as SkillFilter)}
              >
                <ControlPill label={`${t(skillFilters[filter])} (${counts[filter]})`} />
              </Menu>
              <ControlPill
                label={t("Select all")}
                onPress={() =>
                  setSelected(
                    rows
                      .filter((row) => row.kind === "managed" || !row.skill.external)
                      .map((row) => row.key),
                  )
                }
              />
            </>
          )}
          {selected.length > 0 && (
            <View className="flex-row flex-wrap gap-2">
              <ControlPill label={t("Clear selection")} onPress={() => setSelected([])} />
              {chosen.length > 0 && (
                <>
                  <ControlPill
                    label={t("Check updates")}
                    disabled={disabled}
                    onPress={() =>
                      void mutate({
                        type: "batch",
                        operations: chosen.map((skill) => ({ type: "check", id: skill.id })),
                      })
                    }
                  />
                  <ControlPill
                    label={t("Apply available updates")}
                    disabled={disabled}
                    onPress={() =>
                      void mutate({
                        type: "batch",
                        operations: chosen
                          .filter((skill) => skill.availableDigest && skill.policy !== "pinned")
                          .map((skill) => ({
                            type: "update",
                            id: skill.id,
                            digest: skill.availableDigest!,
                          })),
                      })
                    }
                  />
                  <Policy
                    value="automatic"
                    disabled={disabled}
                    onChange={(policy) =>
                      void mutate({
                        type: "batch",
                        operations: chosen.map((skill) => ({
                          type: "policy",
                          id: skill.id,
                          policy,
                        })),
                      })
                    }
                  />
                </>
              )}
              {discovered.length > 0 && (
                <ControlPill
                  label={t("Adopt selected ({count})", { count: discovered.length })}
                  disabled={disabled || previewing}
                  onPress={() => void preview(discovered)}
                />
              )}
            </View>
          )}
          {!rows.length && (
            <Text className="text-foreground-muted">
              {t(counts.all ? "No matching skills" : "No skills found in this environment")}
            </Text>
          )}
          {rows.map((row) => (
            <View key={row.key}>
              <View className="flex-row items-center justify-between gap-2">
                <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
                  {t("Select {name}", { name: row.name })}
                </Text>
                <Switch
                  accessibilityLabel={t("Select {name}", { name: row.name })}
                  disabled={row.kind === "discovered" && row.skill.external}
                  value={selected.includes(row.key)}
                  onValueChange={(checked) =>
                    setSelected(
                      checked ? [...selected, row.key] : selected.filter((key) => key !== row.key),
                    )
                  }
                />
              </View>
              {row.kind === "managed" ? (
                <Skill
                  skill={row.skill}
                  data={data}
                  disabled={disabled || row.skill.status === "fetching"}
                  mutate={mutate}
                  inspect={inspect}
                />
              ) : (
                <View className="gap-2 border-t border-border-subtle py-4">
                  <Text className="font-semibold text-foreground">{row.name}</Text>
                  <Text className="text-xs text-foreground-muted">
                    {t(row.skill.external ? "Maintained externally" : "Unmanaged")} ·{" "}
                    {(row.skill.providers ?? [row.skill.provider]).join(", ")}
                  </Text>
                  <Text numberOfLines={2} className="text-sm text-foreground-muted">
                    {row.skill.description}
                  </Text>
                  {(row.skill.paths ?? [row.skill.path]).map((path) => (
                    <Text key={path} selectable className="text-xs text-foreground-muted">
                      {path}
                    </Text>
                  ))}
                  {row.skill.external ? (
                    <Text className="text-xs text-foreground-muted">
                      {t("Update this skill through its plugin or provider.")}
                    </Text>
                  ) : (
                    <ControlPill
                      label={t("Adopt skill")}
                      disabled={disabled || previewing}
                      onPress={() => void preview([row.skill])}
                    />
                  )}
                </View>
              )}
            </View>
          ))}
        </>
      )}
      {tab === "sources" && (
        <>
          {data.sources.map((source) => (
            <Source
              key={`${source.id}:${source.enabled}:${source.executable}`}
              source={source}
              mutate={mutate}
              disabled={disabled}
            />
          ))}
          <Field label={t("Source name")} value={sourceName} onChange={setSourceName} />
          <Menu
            actions={["skills", "mtskills", "local"].map((kind) => ({
              id: kind,
              title: t(
                kind === "local"
                  ? "Local directory"
                  : kind === "mtskills"
                    ? "Meituan mtskills"
                    : "Vercel skills",
              ),
            }))}
            onPressAction={({ nativeEvent }) =>
              setSourceKind(nativeEvent.event as SkillSource["kind"])
            }
          >
            <ControlPill
              label={t(
                sourceKind === "local"
                  ? "Local directory"
                  : sourceKind === "mtskills"
                    ? "Meituan mtskills"
                    : "Vercel skills",
              )}
              accessibilityLabel={t("Installer type")}
            />
          </Menu>
          <ControlPill
            label={t("Add source")}
            disabled={disabled || !sourceName.trim()}
            onPress={() =>
              void mutate({
                type: "source.save",
                source: {
                  id: `custom-${Date.now()}`,
                  label: sourceName.trim(),
                  kind: sourceKind,
                  enabled: true,
                  executable: "",
                  registry:
                    sourceKind === "mtskills"
                      ? "http://r.npm.sankuai.com"
                      : sourceKind === "skills"
                        ? "https://registry.npmjs.org"
                        : "",
                },
              }).then((ok) => {
                if (ok) setSourceName("");
              })
            }
          />
        </>
      )}
      {tab === "targets" && (
        <>
          {data.targets.map((target) => (
            <View key={target.id} className="gap-2 border-t border-border-subtle py-4">
              <Text className="text-foreground">{target.label}</Text>
              <Text selectable className="text-xs text-foreground-muted">
                {target.directory}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {t("{count} managed skills", {
                  count: data.skills.filter((skill) =>
                    skill.bindings.some((binding) => binding.id === target.id),
                  ).length,
                })}
              </Text>
              {data.customTargets.some((entry) => entry.id === target.id) && (
                <ControlPill
                  label={t("Remove location")}
                  disabled={disabled}
                  onPress={() => void mutate({ type: "target.remove", targetId: target.id })}
                />
              )}
            </View>
          ))}
          <Field label={t("Agent name")} value={label} onChange={setLabel} />
          <Field label={t("Skills directory")} value={directory} onChange={setDirectory} />
          <ControlPill
            label={t("Add usage location")}
            disabled={disabled || !label.trim() || !directory.trim()}
            onPress={() =>
              void mutate({
                type: "target.save",
                target: { id: `custom:${directory}`, label, directory },
              }).then((ok) => {
                if (ok) {
                  setDirectory("");
                  setLabel("");
                }
              })
            }
          />
        </>
      )}
      <ControlPill
        label={t("Recent operations ({count})", { count: data.jobs?.length ?? 0 })}
        onPress={() => setHistory(!history)}
      />
      {history &&
        [...(data.jobs ?? [])].reverse().map((job) => (
          <View key={job.id} className="gap-2">
            <Text className="text-foreground">
              {t(skillJobNames[job.input.type])} ·{" "}
              {t(
                job.status === "completed"
                  ? "Completed"
                  : job.status === "failed"
                    ? "Failed"
                    : job.status === "cancelled"
                      ? "Cancelled"
                      : job.status === "running"
                        ? "Running"
                        : job.status === "waiting"
                          ? "Waiting for idle agents"
                          : "Queued",
              )}{" "}
              · {data.skills.find((skill) => skill.id === job.skillId)?.name}
            </Text>
            <SkillDate value={job.finishedAt ?? job.createdAt} />
            <Text className="text-xs text-foreground-muted">
              {t(
                job.origin === "schedule"
                  ? "Automatic schedule"
                  : job.origin === "recovery"
                    ? "Recovery"
                    : "Requested",
              )}
              {job.afterDigest && job.afterDigest !== job.beforeDigest
                ? ` · ${job.beforeDigest?.slice(0, 8) ?? "–"} → ${job.afterDigest.slice(0, 8)}`
                : ""}
            </Text>
            {job.reason && (
              <Text className="text-danger-foreground">{t(skillFailureMessage(job.reason))}</Text>
            )}
            {job.status === "failed" && (
              <ControlPill
                label={t("Retry this operation")}
                disabled={disabled}
                onPress={() => void mutate(job.input)}
              />
            )}
          </View>
        ))}
    </View>
  );
}
export function SettingsSkillsRouteScreen() {
  const t = useUiTranslation();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title={t("Skill management")} trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4 pb-12"
        >
          {selectedTargets.map((environment) => (
            <SettingsSection key={environment.environmentId} title={environment.label}>
              <EnvironmentSkills environmentId={environment.environmentId} />
            </SettingsSection>
          ))}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

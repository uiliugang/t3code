import { useAtomValue } from "@effect/atom-react";
import { type StaticScreenProps, useNavigation, usePreventRemove } from "@react-navigation/native";
import {
  AuthProvidersManageScope,
  ProviderInstanceId,
  type EnvironmentId,
  type ServerConfig,
  type ServerSettings,
  type VirtualModel,
} from "@t3tools/contracts";
import {
  bindingEditError,
  settingModelLabel,
  virtualModelEdit,
  virtualModelUsage,
} from "@t3tools/shared/virtualModelEditor";
import { inheritedModelRole, virtualModelName } from "@t3tools/shared/virtualModels";
import { useMemo, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { LegendList } from "@legendapp/list/react-native";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Menu } from "../../components/ui/Menu";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { buildModelOptions } from "../../lib/modelOptions";
import {
  applyProviderOptionSelection,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { serverEnvironment } from "../../state/server";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { formatEnvironmentQueryError } from "../../state/query";

type Params = { environmentId: EnvironmentId; id: string; create: boolean };
type Physical = Exclude<VirtualModel["binding"], string | null>;
type Choice = { selection: Physical; label: string; providerLabel: string };

export function SettingsVirtualModelRouteScreen({ route }: StaticScreenProps<Params>) {
  const { environmentId, id, create } = route.params;
  const t = useUiTranslation();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const settings =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId)) ?? config?.settings;
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  if (
    !config ||
    !settings?.virtualModels ||
    !canWrite ||
    !canManage ||
    (!create && !settings.virtualModels[id])
  )
    return (
      <SettingsScreen title={t("Virtual models")}>
        <Text className="p-4 text-foreground-muted">
          {t(!canWrite || !canManage ? "Read-only" : "Not available on this environment")}
        </Text>
      </SettingsScreen>
    );
  return (
    <BindingEditor
      key={`${environmentId}:${id}`}
      {...route.params}
      config={config}
      settings={settings}
    />
  );
}

function BindingEditor({
  environmentId,
  id,
  create,
  config,
  settings,
}: Params & { config: ServerConfig; settings: ServerSettings }) {
  const t = useUiTranslation();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const discover = useAtomCommand(serverEnvironment.listTextGeneratorModels, {
    reportFailure: false,
  });
  const existing = settings.virtualModels?.[id];
  const [initial] = useState(existing);
  const [initialName] = useState(existing?.name ?? (create ? "" : virtualModelName(id, t)));
  const [name, setName] = useState(initialName);
  const [selected, setSelected] = useState<Physical | null>(
    typeof initial?.binding === "object" ? initial.binding : null,
  );
  const parent = inheritedModelRole(id);
  const [inherit, setInherit] = useState(typeof initial?.binding === "string");
  const binding = inherit && parent ? parent : selected;
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [discovered, setDiscovered] = useState<Choice[]>([]);
  const [loading, setLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState("");
  const catalogRequest = useRef(0);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const saved = useRef(false);
  const [saveError, setSaveError] = useState("");
  const { agent, review } = virtualModelUsage(settings, id);
  const providers = config.providers;
  const models = useMemo(() => {
    const eligible = providers.filter(
      (p) =>
        !settings.textGenerators[p.instanceId] &&
        (!review || p.driver === "codex" || p.driver === "claudeAgent") &&
        (agent || p.supportsTextGeneration !== false),
    );
    return buildModelOptions(
      {
        ...config,
        settings,
        providers: eligible.map((p) =>
          agent ? p : { ...p, models: p.models.filter((m) => m.supportsTextGeneration !== false) },
        ),
      },
      null,
      undefined,
      null,
    );
  }, [providers, settings, review, agent, config]);
  const catalogModel = models.find(
    (m) => m.selection.instanceId === selected?.instanceId && m.selection.model === selected.model,
  );
  const descriptors = resolveProviderOptionDescriptors({
    capabilities: catalogModel?.capabilities,
    selections: selected?.options,
  });
  const invalid = bindingEditError(settings, id, name, binding, t);
  const dirty = name !== initialName || binding !== (initial?.binding ?? null);
  const prevent = picking || dirty || saving;
  usePreventRemove(prevent, ({ data }) => {
    if (saved.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (busy.current) return;
    if (picking) {
      setPicking(false);
      return;
    }
    Dialog.confirm({
      title: t("Discard unsaved changes?"),
      cancelText: t("Keep editing"),
      confirmText: t("Discard changes"),
      destructive: true,
      onConfirm: () => navigation.dispatch(data.action),
    });
  });
  async function persist(entry: VirtualModel | undefined) {
    if (!entry || busy.current) return;
    busy.current = true;
    setSaving(true);
    setSaveError("");
    const result = await update({
      environmentId,
      input: { patch: { virtualModels: { [id]: entry } } },
    });
    if (result._tag === "Success") {
      saved.current = true;
      navigation.goBack();
    } else if (result._tag === "Failure") setSaveError(formatEnvironmentQueryError(result.cause));
    busy.current = false;
    setSaving(false);
  }
  function changeOption(key: string, value: string | boolean) {
    const options = applyProviderOptionSelection(descriptors, { id: key, value });
    if (options && selected) setSelected({ ...selected, options });
  }
  async function openPicker() {
    setQuery("");
    setPicking(true);
    setDiscoveryError("");
    const request = ++catalogRequest.current;
    const generators = agent
      ? []
      : Object.entries(settings.textGenerators).filter(([, g]) => g.enabled);
    setLoading(generators.length > 0);
    setDiscovered([]);
    const results = await Promise.all(
      generators.map(async ([key, g]) => {
        const instanceId = ProviderInstanceId.make(key);
        const result = g.model
          ? null
          : await discover({ environmentId, input: { id: instanceId } });
        return {
          choices: (g.model
            ? [{ id: g.model, name: g.model }]
            : result?._tag === "Success"
              ? result.value.models
              : []
          ).map((m) => ({
            selection: { model: m.id, instanceId },
            label: m.name,
            providerLabel: g.label ?? key,
          })),
          error: result?._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
        };
      }),
    );
    if (request !== catalogRequest.current) return;
    setDiscovered(results.flatMap((r) => r.choices));
    setDiscoveryError(results.flatMap((r) => (r.error ? [r.error] : [])).join("\n"));
    setLoading(false);
  }
  if (picking) {
    const needle = query.trim().toLocaleLowerCase();
    const choices: Choice[] = [...models, ...discovered].filter((m) =>
      [m.label, m.providerLabel, m.selection.model, m.selection.instanceId].some((value) =>
        value.toLocaleLowerCase().includes(needle),
      ),
    );
    return (
      <SettingsScreen guardBack title={t("Choose real model")}>
        <View className="px-4 py-2">
          <AppTextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder={t("Search models")}
            accessibilityLabel={t("Search models")}
          />
        </View>
        <LegendList
          renderScrollComponent={NativeScrollView}
          extraData={selected}
          estimatedItemSize={64}
          data={choices}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          keyExtractor={(item) => JSON.stringify([item.selection.instanceId, item.selection.model])}
          ListEmptyComponent={
            <Text className="p-4 text-foreground-muted">
              {t(loading ? "Loading…" : "No models found")}
            </Text>
          }
          ListFooterComponent={
            discoveryError ? (
              <Text className="p-4 text-danger-foreground">{discoveryError}</Text>
            ) : null
          }
          renderItem={({ item }) => (
            <ListChoiceRow
              label={item.label}
              description={item.providerLabel}
              selected={
                selected?.instanceId === item.selection.instanceId &&
                selected.model === item.selection.model
              }
              onPress={() => {
                if (
                  selected?.instanceId !== item.selection.instanceId ||
                  selected.model !== item.selection.model
                )
                  setSelected(item.selection);
                setInherit(false);
                setPicking(false);
              }}
            />
          )}
        />
      </SettingsScreen>
    );
  }
  return (
    <SettingsScreen title={t(create ? "Add virtual model" : "Edit binding")} guardBack={prevent}>
      <ScrollView
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-5 px-5 py-4"
      >
        <View className="gap-2">
          <Text>{t("Virtual model name")}</Text>
          <AppTextInput
            maxLength={80}
            value={name}
            onChangeText={setName}
            accessibilityLabel={t("Virtual model name")}
          />
        </View>
        {parent ? (
          <View className="gap-2">
            <Text>{t("Binding mode")}</Text>
            <SegmentedControl
              selected={inherit ? "inherit" : "direct"}
              options={[
                { value: "direct", label: t("Specific model") },
                { value: "inherit", label: t("Inherit") },
              ]}
              onSelect={(value) => setInherit(value === "inherit")}
            />
          </View>
        ) : null}
        {existing?.binding === null ? (
          <Text className="text-sm text-foreground-muted">{t("Not bound")}</Text>
        ) : null}
        {inherit && parent ? (
          <Text>{settingModelLabel(settings, parent, providers, t, true)}</Text>
        ) : (
          <ListRow
            icon="link"
            label={catalogModel?.label ?? selected?.model ?? t("Choose real model")}
            description={
              catalogModel?.providerLabel ??
              (selected
                ? (settings.textGenerators[selected.instanceId]?.label ?? selected.instanceId)
                : undefined)
            }
            onPress={() => void openPicker()}
          />
        )}
        {!inherit && descriptors.length > 0 ? (
          <SettingsSection title={t("Model parameters")}>
            {descriptors.map((d) =>
              d.type === "boolean" ? (
                <ListToggleRow
                  key={d.id}
                  label={t(d.label)}
                  value={d.currentValue ?? false}
                  onValueChange={(value) => changeOption(d.id, value)}
                />
              ) : (
                <Menu
                  key={d.id}
                  accessibilityLabel={t(d.label)}
                  actions={d.options
                    .filter((o) => !d.promptInjectedValues?.includes(o.id))
                    .map((o) => ({
                      id: o.id,
                      title: t(o.label),
                      state: d.currentValue === o.id ? "on" : "off",
                    }))}
                  onPressAction={({ nativeEvent }) => changeOption(d.id, nativeEvent.event)}
                >
                  <View className="min-h-12 flex-row items-center justify-between gap-2 px-4">
                    <Text>{t(d.label)}</Text>
                    <Text className="shrink text-foreground-muted">
                      {t(d.options.find((o) => o.id === d.currentValue)?.label ?? "Default")}
                    </Text>
                  </View>
                </Menu>
              ),
            )}
          </SettingsSection>
        ) : null}
        {saveError || (invalid && name) ? (
          <Text className="text-danger-foreground">{saveError || invalid}</Text>
        ) : null}
      </ScrollView>
      <View
        className="flex-row items-center justify-between gap-2 border-t border-border-subtle px-4 pt-2"
        style={{ paddingBottom: Math.max(insets.bottom, 8) }}
      >
        {existing?.binding != null ? (
          <Button
            label={t("Unbind model")}
            tone="text"
            disabled={saving}
            onPress={() =>
              Dialog.confirm({
                title: t("Unbind {name}?", { name: existing.name ?? virtualModelName(id, t) }),
                message: t(
                  "Existing references are kept. Conversations using them will fail until this model is bound again.",
                ),
                confirmText: t("Unbind model"),
                destructive: true,
                onConfirm: () => {
                  const current = appAtomRegistry.get(
                    serverEnvironment.settingsValueAtom(environmentId),
                  );
                  if (current) void persist(virtualModelEdit(current, id, { action: "unbind" }, t));
                },
              })
            }
          />
        ) : (
          <View />
        )}
        <Button
          label={t(create ? "Add" : "Save binding")}
          tone="primary"
          loading={saving}
          disabled={!!invalid || (existing?.binding != null && !binding)}
          onPress={() =>
            void persist(virtualModelEdit(settings, id, { action: "save", name, binding }, t))
          }
        />
      </View>
    </SettingsScreen>
  );
}

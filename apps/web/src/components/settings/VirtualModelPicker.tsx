import type {
  SettingsModelSelection as ModelSelection,
  ProviderInstanceId,
  ServerProvider,
  UnifiedSettings,
} from "@t3tools/contracts";
import {
  inheritedModelRole,
  resolveVirtualModel,
  virtualModelName,
  virtualModelFitsRole,
  virtualModelReference,
  type VirtualModelRole,
} from "@t3tools/shared/virtualModels";
import type { UiTranslator } from "@t3tools/shared/uiLocale";
import { Check, ChevronDown, Cpu, Link2, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useEnvironmentProviders } from "../../state/environments";
import {
  getCustomModelOptionsByInstance,
  getTextGenerationModelOptionsByInstance,
} from "../../modelSelection";
import { useTextGenerationTargets } from "../../textGenerators";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "./settingsLayout";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";

export function settingModelLabel(
  settings: UnifiedSettings,
  role: VirtualModelRole,
  providers: readonly ServerProvider[],
  t: UiTranslator,
  inherited = false,
) {
  let key = role;
  const visited = new Set<string>();
  while (!visited.has(key)) {
    visited.add(key);
    const selected = settings[key];
    const id = selected?.virtualModelId;
    const alias = id ? settings.virtualModels?.[id] : null;
    const parent =
      !inherited && typeof alias?.binding === "string"
        ? alias.binding
        : selected === null
          ? inheritedModelRole(key)
          : null;
    if (parent) {
      key = parent;
      inherited = true;
      continue;
    }
    if (id)
      return t("Inherit ({model})", {
        model: t("{name} virtual model", { name: alias?.name ?? virtualModelName(id, t) }),
      });
    if (!selected) return t(key === "fallbackModelSelection" ? "None" : "Automatic");
    const name =
      providers
        .find((p) => p.instanceId === selected.instanceId)
        ?.models.find((m) => m.slug === selected.model)?.name ?? selected.model;
    return inherited ? t("Inherit ({model})", { model: name }) : name;
  }
  return t("Not bound");
}

export function VirtualModelPicker({ role }: { role: VirtualModelRole }) {
  const t = useUiTranslation();
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const { target, targets: scopedTargets } = useSettingsScope();
  const mixed = useScopedSettingsMixed([role]);
  const environmentId = target?.environmentId ?? null;
  const providersByEnvironment = useEnvironmentProviders();
  const providers = environmentId
    ? (providersByEnvironment.get(environmentId) ?? EMPTY_SERVER_PROVIDERS)
    : EMPTY_SERVER_PROVIDERS;
  const value = settings[role];
  const physical = resolveVirtualModel(settings, value);
  const targets = useTextGenerationTargets({
    environmentId,
    settings,
    providers,
    projectId: target?.projectId ?? null,
    selections: [physical],
  });
  const agent =
    role === "defaultModelSelection" ||
    role === "fallbackModelSelection" ||
    role === "reviewGuideModelSelection";
  const disabledReason = useScopedModelDisabledReason(settings, targets.entries, !agent);
  const [open, setOpen] = useState(false);
  const [direct, setDirect] = useState(false);
  const [query, setQuery] = useState("");
  const matches = (...s: string[]) =>
    s.join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const save = (selection: ModelSelection | null) => {
    if (selection || role !== "textGenerationModelSelection") update({ [role]: selection });
    setOpen(false);
  };
  const entries = targets.entries.filter((e) => !agent || !settings.textGenerators[e.instanceId]);
  const acceptable = (id: ProviderInstanceId) =>
    role !== "reviewGuideModelSelection" ||
    providers.some(
      (p) => p.instanceId === id && (p.driver === "codex" || p.driver === "claudeAgent"),
    );
  const choices: {
    id: string;
    label: string;
    sub?: string;
    selected: boolean;
    disabled?: boolean;
    choose: () => void;
  }[] = [];
  const fitsTargets = (id: string) =>
    scopedTargets.every((scope) =>
      virtualModelFitsRole(
        scope.settings,
        id,
        role,
        scope.projectId,
        providersByEnvironment.get(scope.environmentId),
      ),
    );
  if (open && direct) {
    const models = (
      agent ? getCustomModelOptionsByInstance : getTextGenerationModelOptionsByInstance
    )(settings, agent ? providers : targets.providers, physical?.instanceId, physical?.model);
    for (const entry of entries) {
      if (!entry.enabled || !entry.isAvailable || !acceptable(entry.instanceId)) continue;
      for (const model of models.get(entry.instanceId) ?? [])
        if (matches(model.name, model.slug, entry.displayName))
          choices.push({
            id: JSON.stringify([entry.instanceId, model.slug]),
            label: model.name,
            sub: entry.displayName,
            selected:
              !value?.virtualModelId &&
              value?.instanceId === entry.instanceId &&
              value.model === model.slug,
            disabled: !!model.isUnavailable || !!disabledReason(entry.instanceId, model.slug),
            choose: () =>
              save(
                value &&
                  !value.virtualModelId &&
                  value.instanceId === entry.instanceId &&
                  value.model === model.slug
                  ? value
                  : { instanceId: entry.instanceId, model: model.slug },
              ),
          });
    }
  } else if (open) {
    if (role !== "textGenerationModelSelection") {
      const label = settingModelLabel({ ...settings, [role]: null }, role, targets.providers, t);
      const resolved = inheritedModelRole(role);
      if (
        matches(
          label,
          resolved ? (resolveVirtualModel(settings, settings[resolved])?.model ?? "") : "",
        )
      )
        choices.push({ id: "none", label, selected: value === null, choose: () => save(null) });
    }
    for (const [id, alias] of Object.entries(settings.virtualModels ?? {})) {
      const ref = virtualModelReference(id);
      const resolved = resolveVirtualModel({ ...settings, [role]: ref }, ref);
      const name = alias.name ?? virtualModelName(id, t);
      if (!matches(name, resolved.model, resolved.instanceId)) continue;
      choices.push({
        id,
        label: name,
        sub: resolved.virtualModelId
          ? t("Not bound")
          : id === role
            ? t("Default option")
            : t("Virtual model"),
        selected: value?.virtualModelId === id,
        disabled: !fitsTargets(id),
        choose: () => save(ref),
      });
    }
  }
  const entry =
    value && !value.virtualModelId ? entries.find((e) => e.instanceId === value.instanceId) : null;
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
      {physical?.virtualModelId && !mixed ? (
        <span className="text-xs text-warning">{t("Not bound")}</span>
      ) : null}
      <Popover
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (v) {
            setQuery("");
            setDirect(!!value && !value.virtualModelId);
          }
        }}
      >
        <PopoverTrigger render={<Button size="sm" variant="outline" />}>
          {value?.virtualModelId || !value ? <Link2 /> : <Cpu />}
          <span className="max-w-52 truncate">
            {mixed ? t("Mixed") : settingModelLabel(settings, role, targets.providers, t)}
          </span>
          <ChevronDown />
        </PopoverTrigger>
        <PopoverPopup width="md" padding="compact" align="end">
          <div className="grid gap-2">
            <div className="flex gap-1">
              {[false, true].map((mode) => (
                <Button
                  key={String(mode)}
                  size="sm"
                  variant={direct === mode ? "secondary" : "ghost"}
                  aria-pressed={direct === mode}
                  onClick={() => {
                    setDirect(mode);
                    setQuery("");
                  }}
                >
                  {mode ? <Cpu /> : <Link2 />}
                  {t(mode ? "Real models" : "Virtual models")}
                </Button>
              ))}
            </div>
            <Input
              autoFocus
              aria-label={t("Search models")}
              placeholder={t("Search models")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="max-h-64 overflow-y-auto">
              {choices.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  disabled={c.disabled}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-accent focus-visible:bg-accent disabled:opacity-50"
                  onClick={c.choose}
                >
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  <small className="text-muted-foreground">{c.sub}</small>
                  {c.selected ? <Check className="size-4" /> : null}
                </button>
              ))}
              {choices.length === 0 ? (
                <p className="p-2 text-sm text-muted-foreground">{t("No matching models")}</p>
              ) : null}
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={open && !fitsTargets(role)}
              onClick={() => save(virtualModelReference(role))}
            >
              <RotateCcw />
              {t("Reset to default")}
            </Button>
          </div>
        </PopoverPopup>
      </Popover>
      {!mixed && value && entry ? (
        <TraitsPicker
          provider={entry.driverKind}
          models={entry.models}
          model={value.model}
          modelOptions={value.options ?? []}
          allowPromptInjectedEffort={false}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          onModelOptionsChange={(options) =>
            save({
              instanceId: value.instanceId,
              model: value.model,
              ...(options ? { options } : {}),
            })
          }
        />
      ) : null}
    </div>
  );
}

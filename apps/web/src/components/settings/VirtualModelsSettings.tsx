import type {
  EnvironmentId,
  ServerProvider,
  UnifiedSettings,
  VirtualModel,
} from "@t3tools/contracts";
import {
  inheritedModelRole,
  resolveVirtualModel,
  virtualModelName,
  virtualModelReference,
  virtualModelRoles,
} from "@t3tools/shared/virtualModels";
import { Link2, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { randomUUID } from "../../lib/utils";
import { useTextGenerationTargets } from "../../textGenerators";
import {
  getCustomModelOptionsByInstance,
  getTextGenerationModelOptionsByInstance,
} from "../../modelSelection";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { SettingsSection, SettingsRow, SETTINGS_PICKER_TRIGGER_CLASSNAME } from "./settingsLayout";
import { settingModelLabel } from "./VirtualModelPicker";

type Props = {
  environmentId: EnvironmentId;
  providers: readonly ServerProvider[];
  readOnly: boolean;
};
export function VirtualModelsSettings({ environmentId, providers, readOnly }: Props) {
  const t = useUiTranslation();
  const settings = useEnvironmentSettings(environmentId);
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  if (!settings.virtualModels) return null;
  const rows = Object.entries(settings.virtualModels)
    .map(([id, entry]) => {
      const name = entry.name ?? virtualModelName(id, t);
      const value = resolveVirtualModel(settings, virtualModelReference(id));
      const description = value.virtualModelId
        ? t("Not bound")
        : typeof entry.binding === "string"
          ? settingModelLabel(settings, entry.binding, providers, t, true)
          : [
              providers.find((p) => p.instanceId === value.instanceId)?.displayName ??
                value.instanceId,
              value.model,
              ...(value.options ?? []).map((o) => `${o.id}: ${o.value}`),
            ].join(" · ");
      return { id, name, description };
    })
    .filter((row) =>
      [row.name, row.description]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    );
  return (
    <SettingsSection
      title={t("Virtual models")}
      icon={<Link2 />}
      headerAction={
        !readOnly ? (
          <Button size="sm" variant="outline" onClick={() => setEditing(randomUUID())}>
            <Plus />
            {t("Add")}
          </Button>
        ) : null
      }
    >
      <div className="px-3 py-2">
        <Input
          aria-label={t("Search virtual models")}
          placeholder={t("Search virtual models")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {rows.map((row) => (
        <SettingsRow
          key={row.id}
          title={row.name}
          description={row.description}
          control={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Edit binding: {name}", { name: row.name })}
              title={t("Edit binding: {name}", { name: row.name })}
              disabled={readOnly}
              onClick={() => setEditing(row.id)}
            >
              <Pencil />
            </Button>
          }
        />
      ))}
      {!rows.length ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">{t("No matching models")}</p>
      ) : null}
      {editing !== null && !readOnly ? (
        <BindingEditor
          key={editing}
          id={editing}
          environmentId={environmentId}
          settings={settings}
          providers={providers}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

function BindingEditor({
  id,
  environmentId,
  settings,
  providers,
  onClose,
}: Omit<Props, "readOnly"> & { id: string; settings: UnifiedSettings; onClose: () => void }) {
  const t = useUiTranslation();
  const update = useUpdateEnvironmentSettings(environmentId);
  const existing = settings.virtualModels?.[id];
  const builtIn = virtualModelRoles.some((r) => r === id);
  const [name, setName] = useState(existing?.name ?? (builtIn ? virtualModelName(id, t) : ""));
  const [binding, setBinding] = useState<VirtualModel["binding"]>(existing?.binding ?? null);
  const [saving, setSaving] = useState(false);
  const selected = typeof binding === "object" ? binding : null;
  const parent = inheritedModelRole(id);
  const targets = useTextGenerationTargets({
    environmentId,
    providers,
    settings,
    projectId: null,
    selections: [selected],
  });
  const references = virtualModelRoles.filter(
    (key) =>
      key === id ||
      settings[key]?.virtualModelId === id ||
      ((key === "defaultModelSelection" || key === "reviewGuideModelSelection") &&
        Object.values(settings.projectSettingsOverrides).some(
          (override) => override[key]?.virtualModelId === id,
        )),
  );
  const agent = references.some(
    (key) =>
      key === "defaultModelSelection" ||
      key === "fallbackModelSelection" ||
      key === "reviewGuideModelSelection",
  );
  const review = references.includes("reviewGuideModelSelection");
  const entries = targets.entries.filter(
    (e) =>
      (!agent || !settings.textGenerators[e.instanceId]) &&
      (!review || e.driverKind === "codex" || e.driverKind === "claudeAgent"),
  );
  const options = (
    agent ? getCustomModelOptionsByInstance : getTextGenerationModelOptionsByInstance
  )(settings, agent ? providers : targets.providers, selected?.instanceId, selected?.model);
  const active = entries.find((e) => e.instanceId === selected?.instanceId);
  const duplicate = Object.entries(settings.virtualModels ?? {}).some(
    ([key, m]) => key !== id && (m.name ?? virtualModelName(key, t)) === name.trim(),
  );
  const cyclic =
    typeof binding === "string" &&
    [
      settings,
      ...Object.values(settings.projectSettingsOverrides).map((override) => ({
        ...settings,
        textGenerationModelSelection:
          override.textGenerationModelSelection ?? settings.textGenerationModelSelection,
        sourceControlWriterModelSelection:
          override.sourceControlWriterModelSelection === undefined
            ? settings.sourceControlWriterModelSelection
            : override.sourceControlWriterModelSelection,
      })),
    ].some((scope) => {
      const prospective = {
        ...scope,
        virtualModels: { ...settings.virtualModels, [id]: { binding } },
      };
      const unresolved = resolveVirtualModel(prospective, virtualModelReference(id)).virtualModelId;
      return unresolved !== undefined && prospective.virtualModels[unresolved]?.binding != null;
    });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t(existing ? "Edit binding" : "Add virtual model")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <label className="grid gap-1.5 text-sm">
              {t("Virtual model name")}
              <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="flex flex-wrap gap-2">
              {entries.length ? (
                <ProviderModelPicker
                  environmentId={environmentId}
                  activeInstanceId={selected?.instanceId ?? entries[0]!.instanceId}
                  model={selected?.model ?? ""}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={options}
                  {...(selected ? {} : { triggerLabel: t("Choose real model") })}
                  onInstanceModelChange={(instanceId, model) => setBinding({ instanceId, model })}
                />
              ) : null}
              {active && selected ? (
                <TraitsPicker
                  provider={active.driverKind}
                  models={active.models}
                  model={selected.model}
                  modelOptions={selected.options ?? []}
                  allowPromptInjectedEffort={false}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onModelOptionsChange={(options) =>
                    setBinding({
                      instanceId: selected.instanceId,
                      model: selected.model,
                      ...(options ? { options } : {}),
                    })
                  }
                />
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {parent ? (
                <Button
                  size="sm"
                  variant={typeof binding === "string" ? "secondary" : "outline"}
                  aria-pressed={binding === parent}
                  onClick={() => setBinding(parent)}
                >
                  {settingModelLabel(settings, parent, providers, t, true)}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant={binding === null ? "secondary" : "outline"}
                aria-pressed={binding === null}
                onClick={() => setBinding(null)}
              >
                {t("Not bound")}
              </Button>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={saving || !name.trim() || duplicate || cyclic}
            onClick={() => {
              setSaving(true);
              update(
                {
                  virtualModels: {
                    [id]: {
                      ...(builtIn && name.trim() === virtualModelName(id, t)
                        ? {}
                        : { name: name.trim() }),
                      binding,
                    },
                  },
                },
                { onSaved: onClose, onFailed: () => setSaving(false) },
              );
            }}
          >
            {t("Save binding")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

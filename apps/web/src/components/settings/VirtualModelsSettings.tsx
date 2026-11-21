import type {
  EnvironmentId,
  ServerProvider,
  UnifiedSettings,
  VirtualModel,
} from "@t3tools/contracts";
import {
  inheritedModelRole,
  virtualModelName,
  virtualModelRoles,
} from "@t3tools/shared/virtualModels";
import { CornerDownRight, Cpu, Link2, MoreVertical, Plus, Unlink } from "lucide-react";
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
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { SettingsSection, SettingsRow, SETTINGS_PICKER_TRIGGER_CLASSNAME } from "./settingsLayout";
import {
  bindingEditError,
  settingModelLabel,
  virtualModelDescription,
  virtualModelEdit,
  virtualModelUsage,
} from "@t3tools/shared/virtualModelEditor";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

type Props = {
  environmentId: EnvironmentId;
  providers: readonly ServerProvider[];
  readOnly: boolean;
};
export function VirtualModelsSettings({ environmentId, providers, readOnly }: Props) {
  const t = useUiTranslation();
  const settings = useEnvironmentSettings(environmentId);
  const update = useUpdateEnvironmentSettings(environmentId);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  if (!settings.virtualModels) return null;
  const rows = Object.entries(settings.virtualModels).map(([id, entry]) => {
    const name = entry.name ?? virtualModelName(id, t);
    const description = virtualModelDescription(settings, id, providers, t);
    return { id, name, description };
  });
  const removingRow = rows.find((row) => row.id === removing);
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
      {rows.map((row) => (
        <SettingsRow
          key={row.id}
          title={row.name}
          description={row.description}
          control={
            readOnly ? null : (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      variant="ghost-muted"
                      size="icon-sm"
                      aria-label={t("More actions for {name}", { name: row.name })}
                      title={t("More actions for {name}", { name: row.name })}
                    />
                  }
                >
                  <MoreVertical />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem onClick={() => setEditing(row.id)}>{t("Edit")}</MenuItem>
                  <MenuItem variant="destructive" onClick={() => setRemoving(row.id)}>
                    {t("Remove")}
                  </MenuItem>
                </MenuPopup>
              </Menu>
            )
          }
        />
      ))}
      {!rows.length ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">{t("No models found")}</p>
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
      <AlertDialog
        open={removingRow !== undefined && !readOnly}
        onOpenChange={(open) => {
          if (!open && !deleting) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Remove {name}?", { name: removingRow?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "This removes the virtual model without changing existing references. Requests using those references will fail.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={deleting} />}>
              {t("Cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => {
                if (readOnly || removing === null) return;
                setDeleting(true);
                update(
                  { virtualModels: { [removing]: null } },
                  {
                    onSaved: () => {
                      setRemoving(null);
                      setDeleting(false);
                    },
                    onFailed: () => setDeleting(false),
                  },
                );
              }}
            >
              {t("Remove")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
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
  const [initial] = useState(existing);
  const [selected, setBinding] = useState(
    typeof existing?.binding === "object" ? existing.binding : null,
  );
  const [inherit, setInherit] = useState(typeof existing?.binding === "string");
  const [confirm, setConfirm] = useState<"discard" | "unbind" | null>(null);
  const [saving, setSaving] = useState(false);
  const parent = inheritedModelRole(id);
  const binding = inherit && parent ? parent : selected;
  const targets = useTextGenerationTargets({
    environmentId,
    providers,
    settings,
    projectId: null,
    selections: [selected],
  });
  const { agent, review } = virtualModelUsage(settings, id);
  const entries = targets.entries.filter(
    (e) =>
      (!agent || !settings.textGenerators[e.instanceId]) &&
      (!review || e.driverKind === "codex" || e.driverKind === "claudeAgent"),
  );
  const options = (
    agent ? getCustomModelOptionsByInstance : getTextGenerationModelOptionsByInstance
  )(settings, agent ? providers : targets.providers, selected?.instanceId, selected?.model);
  const active = entries.find((e) => e.instanceId === selected?.instanceId);
  const error = bindingEditError(settings, id, name, binding, t);
  const close = () => {
    if (saving) return;
    if (
      name !== (initial?.name ?? (builtIn ? virtualModelName(id, t) : "")) ||
      binding !== (initial?.binding ?? null)
    )
      setConfirm("discard");
    else onClose();
  };
  const persist = (entry: VirtualModel | undefined) => {
    if (!entry || saving || (initial && !existing)) return;
    setSaving(true);
    update(
      { virtualModels: { [id]: entry } },
      { onSaved: onClose, onFailed: () => setSaving(false) },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
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
            {parent ? (
              <div className="grid gap-1.5">
                <span className="text-sm">{t("Binding mode")}</span>
                <ToggleGroup
                  aria-label={t("Binding mode")}
                  value={[inherit ? "inherit" : "direct"]}
                  onValueChange={(values) => {
                    if (values.length) setInherit(values[0] === "inherit");
                  }}
                >
                  <Toggle value="direct">
                    <Cpu />
                    {t("Specific model")}
                  </Toggle>
                  <Toggle value="inherit">
                    <CornerDownRight />
                    {t("Inherit")}
                  </Toggle>
                </ToggleGroup>
              </div>
            ) : null}
            {existing?.binding === null ? (
              <span className="text-sm text-muted-foreground">{t("Not bound")}</span>
            ) : null}
            {inherit && parent ? (
              <p className="text-sm">{settingModelLabel(settings, parent, providers, t, true)}</p>
            ) : (
              <div className="grid justify-items-start gap-2">
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
                ) : (
                  <p className="text-sm text-muted-foreground">{t("No models found")}</p>
                )}
                {active && selected ? (
                  <div className="hidden gap-1.5 has-[button]:grid">
                    <span className="text-sm">{t("Model parameters")}</span>
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
                  </div>
                ) : null}
              </div>
            )}
            {error && name ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter className="flex-row items-center justify-end">
          {existing?.binding != null ? (
            <Button
              className="mr-auto"
              variant="ghost-destructive"
              disabled={saving}
              onClick={() => setConfirm("unbind")}
            >
              <Unlink />
              {t("Unbind model")}
            </Button>
          ) : null}
          <Button variant="ghost" disabled={saving} onClick={close}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={
              saving ||
              !!error ||
              (initial != null && !existing) ||
              (existing?.binding != null && !binding)
            }
            onClick={() =>
              persist(virtualModelEdit(settings, id, { action: "save", name, binding }, t))
            }
          >
            {t(existing ? "Save binding" : "Add")}
          </Button>
        </DialogFooter>
        <AlertDialog
          open={confirm !== null}
          onOpenChange={(open) => {
            if (!open && !saving) setConfirm(null);
          }}
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirm === "unbind"
                  ? t("Unbind {name}?", { name: existing?.name ?? virtualModelName(id, t) })
                  : t("Discard unsaved changes?")}
              </AlertDialogTitle>
              {confirm === "unbind" ? (
                <AlertDialogDescription>
                  {t(
                    "Existing references are kept. Conversations using them will fail until this model is bound again.",
                  )}
                </AlertDialogDescription>
              ) : null}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" disabled={saving} />}>
                {confirm === "unbind" ? t("Cancel") : t("Keep editing")}
              </AlertDialogClose>
              <Button
                variant="destructive"
                disabled={saving}
                onClick={() =>
                  confirm === "unbind"
                    ? persist(virtualModelEdit(settings, id, { action: "unbind" }, t))
                    : onClose()
                }
              >
                {confirm === "unbind" ? t("Unbind model") : t("Discard changes")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </DialogPopup>
    </Dialog>
  );
}

import type { ServerProvider, ServerSettings, VirtualModel } from "@t3tools/contracts";
import type { UiTranslator } from "./uiLocale.ts";
import {
  inheritedModelRole,
  virtualModelName,
  resolveVirtualModel,
  virtualModelReference,
  virtualModelRoles,
  type VirtualModelRole,
} from "./virtualModels.ts";

export function virtualModelUsage(settings: ServerSettings, id: string) {
  const referenced = (key: VirtualModelRole) =>
    key === id ||
    settings[key]?.virtualModelId === id ||
    ((key === "defaultModelSelection" || key === "reviewGuideModelSelection") &&
      Object.values(settings.projectSettingsOverrides).some(
        (project) => project[key]?.virtualModelId === id,
      ));
  const review = referenced("reviewGuideModelSelection");
  return {
    agent: review || referenced("defaultModelSelection") || referenced("fallbackModelSelection"),
    review,
  };
}

export function bindingEditError(
  settings: ServerSettings,
  id: string,
  name: string,
  binding: VirtualModel["binding"],
  t: UiTranslator,
) {
  if (!name.trim()) return t("Enter a virtual model name.");
  if (
    Object.entries(settings.virtualModels ?? {}).some(
      ([key, entry]) => key !== id && (entry.name ?? virtualModelName(key, t)) === name.trim(),
    )
  )
    return t("This virtual model name is already in use.");
  if (typeof binding !== "string") return null;
  const virtualModels = { ...settings.virtualModels, [id]: { binding } };
  const cycle = [undefined, ...Object.values(settings.projectSettingsOverrides)].some((project) => {
    const unresolved = resolveVirtualModel(
      {
        ...settings,
        virtualModels,
        textGenerationModelSelection:
          project?.textGenerationModelSelection ?? settings.textGenerationModelSelection,
        sourceControlWriterModelSelection:
          project?.sourceControlWriterModelSelection === undefined
            ? settings.sourceControlWriterModelSelection
            : project.sourceControlWriterModelSelection,
      },
      virtualModelReference(id),
    ).virtualModelId;
    return unresolved !== undefined && virtualModels[unresolved]?.binding != null;
  });
  return cycle ? t("This binding would create an inheritance cycle.") : null;
}

export function virtualModelEdit(
  settings: ServerSettings,
  id: string,
  edit: { action: "unbind" } | { action: "save"; name: string; binding: VirtualModel["binding"] },
  t: UiTranslator,
): VirtualModel | undefined {
  if (edit.action === "unbind") {
    const saved = settings.virtualModels?.[id];
    return saved?.binding != null ? { ...saved, binding: null } : undefined;
  }
  const name = edit.name.trim();
  return virtualModelRoles.some((role) => role === id) && name === virtualModelName(id, t)
    ? { binding: edit.binding }
    : { name, binding: edit.binding };
}

export function virtualModelDescription(
  settings: ServerSettings,
  id: string,
  providers: readonly ServerProvider[],
  t: UiTranslator,
) {
  const binding = settings.virtualModels?.[id]?.binding;
  const value = resolveVirtualModel(settings, virtualModelReference(id));
  if (!binding || value.virtualModelId) return t("Not bound");
  if (typeof binding === "string") return settingModelLabel(settings, binding, providers, t, true);
  return [
    settings.textGenerators[value.instanceId]?.label ??
      providers.find((p) => p.instanceId === value.instanceId)?.displayName ??
      value.instanceId,
    value.model,
    ...(value.options ?? []).map((o) => `${o.id}: ${o.value}`),
  ].join(" · ");
}

export function settingModelLabel(
  settings: ServerSettings,
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
    const parent = selected === null ? inheritedModelRole(key) : null;
    if (parent) {
      key = parent;
      inherited = true;
      continue;
    }
    if (id) {
      const name = t("{name} virtual model", { name: alias?.name ?? virtualModelName(id, t) });
      return inherited ? t("Inherit ({model})", { model: name }) : name;
    }
    if (!selected) return t(key === "fallbackModelSelection" ? "None" : "Automatic");
    const name =
      providers
        .find((p) => p.instanceId === selected.instanceId)
        ?.models.find((m) => m.slug === selected.model)?.name ?? selected.model;
    return inherited ? t("Inherit ({model})", { model: name }) : name;
  }
  return t("Not bound");
}

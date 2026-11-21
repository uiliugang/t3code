import type { ServerProvider, ServerSettings } from "@t3tools/contracts";
import type { UiTranslator } from "@t3tools/shared/uiLocale";
import {
  inheritedModelRole,
  virtualModelName,
  type VirtualModelRole,
} from "@t3tools/shared/virtualModels";

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

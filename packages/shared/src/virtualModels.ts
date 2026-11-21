import {
  ProviderInstanceId,
  type ProjectId,
  resolveProjectProviderInstanceEnabled,
  resolveTextGenerationSelectionEnabled,
  type SettingsModelSelection as ModelSelection,
  type ProjectSettingsOverrides,
  type ServerSettings,
  type VirtualModel,
  type ServerProvider,
} from "@t3tools/contracts";

export const virtualModelRoles = [
  "defaultModelSelection",
  "fallbackModelSelection",
  "textGenerationModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "speechPostProcessingModelSelection",
] as const;
export type VirtualModelRole = (typeof virtualModelRoles)[number];
const roleNames = {
  defaultModelSelection: "Default",
  fallbackModelSelection: "Fallback",
  textGenerationModelSelection: "Text generation",
  sourceControlWriterModelSelection: "Source control writer",
  reviewGuideModelSelection: "Review guide",
  speechPostProcessingModelSelection: "Voice cleanup",
} satisfies Record<VirtualModelRole, string>;
export function virtualModelName(id: string, t: (s: string) => string) {
  return Object.hasOwn(roleNames, id) ? t(roleNames[id as VirtualModelRole]) : id;
}
export function inheritedModelRole(key: string) {
  if (key === "reviewGuideModelSelection") return "sourceControlWriterModelSelection";
  if (key === "sourceControlWriterModelSelection" || key === "speechPostProcessingModelSelection")
    return "textGenerationModelSelection";
  return null;
}

export function virtualModelReference(id: string): ModelSelection {
  return { virtualModelId: id, instanceId: ProviderInstanceId.make("t3-virtual"), model: id };
}

export function virtualModelFitsRole(
  settings: ServerSettings,
  id: string,
  role: VirtualModelRole,
  projectId: ProjectId | null = null,
  providers?: readonly ServerProvider[],
) {
  if (!settings.virtualModels?.[id]) return false;
  const ref = virtualModelReference(id);
  const resolved = resolveVirtualModel({ ...settings, [role]: ref }, ref);
  if (resolved.virtualModelId)
    return settings.virtualModels[resolved.virtualModelId]?.binding == null;
  const instance = resolved.instanceId;
  const agent =
    role === "defaultModelSelection" ||
    role === "fallbackModelSelection" ||
    role === "reviewGuideModelSelection";
  if (
    !(agent ? resolveProjectProviderInstanceEnabled : resolveTextGenerationSelectionEnabled)(
      settings,
      projectId,
      instance,
    )
  )
    return false;
  if (settings.textGenerators[instance]) return !agent;
  const provider = providers?.find((p) => p.instanceId === instance);
  const driver = provider?.driver ?? settings.providerInstances[instance]?.driver ?? instance;
  if (role === "reviewGuideModelSelection") return driver === "codex" || driver === "claudeAgent";
  return (
    agent ||
    (provider?.supportsTextGeneration !== false &&
      provider?.models.find((m) => m.slug === resolved.model)?.supportsTextGeneration !== false)
  );
}

export function projectVirtualModels(settings: ProjectSettingsOverrides, source: ServerSettings) {
  const ids = new Set(
    [
      settings.defaultModelSelection,
      settings.textGenerationModelSelection,
      settings.sourceControlWriterModelSelection,
      settings.reviewGuideModelSelection,
    ].flatMap((s) => (s?.virtualModelId ? [s.virtualModelId] : [])),
  );
  return Object.fromEntries(
    [...ids].map((id) => [id, source.virtualModels?.[id] ?? { binding: null }]),
  );
}

export function bindingProviders(models: ServerSettings["virtualModels"]) {
  return Object.values(models ?? {}).flatMap(({ binding }) =>
    binding && typeof binding !== "string" ? [binding.instanceId] : [],
  );
}

export function migrateVirtualModels(
  settings: ServerSettings,
  policyPaths: readonly string[] = [],
): ServerSettings {
  if (settings.virtualModels != null) return settings;
  const virtualModels: Record<string, VirtualModel> = {};
  const next = { ...settings, virtualModels };
  for (const key of virtualModelRoles) {
    const binding = settings[key] ?? inheritedModelRole(key);
    virtualModels[key] = { binding };
    if (binding !== null && !policyPaths.some((path) => path === key || path.startsWith(`${key}.`)))
      next[key] = virtualModelReference(key);
  }
  return next;
}

/** Keep the unresolved ID so a missing binding never turns into automatic selection. */
export function resolveVirtualModel(
  settings: ServerSettings,
  selection: ModelSelection,
): ModelSelection;
export function resolveVirtualModel(
  settings: ServerSettings,
  selection: ModelSelection | null,
): ModelSelection | null;
export function resolveVirtualModel(
  settings: ServerSettings,
  selection: ModelSelection | null,
): ModelSelection | null {
  if (!selection?.virtualModelId) return selection;
  let current = selection;
  const seen = new Set<string>();
  while (current.virtualModelId) {
    const id = current.virtualModelId;
    if (seen.has(id)) return current;
    seen.add(id);
    const binding = settings.virtualModels?.[id]?.binding;
    if (!binding) return current;
    if (typeof binding === "string")
      current = settings[binding] ?? settings.textGenerationModelSelection;
    else current = binding;
  }
  return current;
}

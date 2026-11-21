import type { ExecutionEnvironmentCapabilities, MaintainableTool } from "@t3tools/contracts";
import type { UiTranslator } from "@t3tools/shared/uiLocale";

export type MeituanSettingsSection = "code" | "issues" | "daxiang" | "skills";

export function toolSubscriptionsFor(
  capabilities: ExecutionEnvironmentCapabilities,
  ids: readonly MaintainableTool["id"][],
) {
  return {
    sourceControl:
      capabilities.sourceControlToolMaintenance === true &&
      ids.some((id) => id === "git" || id === "github" || id === "meituan"),
    meituan:
      capabilities.meituanTools === true &&
      ids.some((id) => id === "ones2" || id === "mcm" || id === "mtskills" || id === "dumbo-web"),
  };
}

export function meituanAssociationCountLabel(
  projectCount: number,
  query: { data: readonly { error?: string }[] | null; error: string | null },
  associatedProjectCount: number,
  t: UiTranslator,
) {
  if (query.error || query.data?.some((result) => result.error)) return t("Unknown");
  return projectCount > 0 && query.data === null
    ? t("Loading")
    : t("{count} projects", { count: associatedProjectCount });
}

export function shouldDiscoverMeituanProjectSources(section?: MeituanSettingsSection) {
  return section === undefined || section === "issues";
}

export function meituanToolIdsForSection(
  section: MeituanSettingsSection | undefined,
  enabled: { code: boolean; issues: boolean; skills: boolean; daxiang?: boolean },
): MaintainableTool["id"][] {
  if (section === "code") return enabled.code ? ["meituan"] : [];
  if (section === "issues") return enabled.issues ? ["ones2", "mcm"] : [];
  if (section === "skills") return enabled.skills ? ["mtskills"] : [];
  if (section === "daxiang") return enabled.daxiang ? ["dumbo-web"] : [];
  return [
    ...(enabled.code ? (["meituan"] as const) : []),
    ...(enabled.issues ? (["ones2", "mcm"] as const) : []),
    ...(enabled.daxiang ? (["dumbo-web"] as const) : []),
    ...(enabled.skills ? (["mtskills"] as const) : []),
  ];
}

import type { MaintainableTool } from "@t3tools/contracts";

export type MeituanSettingsSection = "code" | "issues" | "daxiang" | "skills";

export function shouldDiscoverMeituanProjectSources(section?: MeituanSettingsSection) {
  return section === undefined || section === "issues";
}

export function meituanToolIdsForSection(
  section: MeituanSettingsSection | undefined,
  enabled: { code: boolean; issues: boolean; skills: boolean },
): MaintainableTool["id"][] {
  if (section === "code") return enabled.code ? ["meituan"] : [];
  if (section === "issues") return enabled.issues ? ["ones2", "mcm"] : [];
  if (section === "skills") return enabled.skills ? ["mtskills"] : [];
  if (section === "daxiang") return [];
  return [
    ...(enabled.code ? (["meituan"] as const) : []),
    ...(enabled.issues ? (["ones2", "mcm"] as const) : []),
    ...(enabled.skills ? (["mtskills"] as const) : []),
  ];
}

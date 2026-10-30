import type { SkillAction } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  skillFailureMessage,
  type ManagedSkill,
  type SkillSnapshot,
  type SkillSource,
  type SkillUpdatePolicy,
} from "@t3tools/contracts";
import type { UiTranslator } from "./uiLocale.ts";

export const skillPolicies: Record<SkillUpdatePolicy, string> = {
  automatic: "Automatic updates",
  notify: "Manual updates",
  manual: "No updates",
  pinned: "No updates",
};
export const skillFilters = {
  all: "All skills",
  unmanaged: "Unmanaged",
  updates: "Updates",
  attention: "Needs attention",
} as const;
export type SkillFilter = keyof typeof skillFilters;
export function skillSourceName(source: Pick<SkillSource, "id" | "label">, t: UiTranslator) {
  return (source.id === "local" && source.label === "Local import") ||
    (source.id === "meituan" && source.label === "Meituan Skills")
    ? t(source.label)
    : source.label;
}
function skillAttention(skill: ManagedSkill) {
  return (
    skill.status === "failed" ||
    Boolean(skill.failureReason) ||
    Boolean(skill.snapshotOnly) ||
    skill.bindings.some((target) => target.status === "conflict")
  );
}
export function skillStatus(skill: ManagedSkill) {
  if (skill.status === "fetching") return "Downloading package";
  if (skill.status === "removing") return "Removing";
  if (skill.status === "pending") return "Waiting for idle agents";
  if (skillAttention(skill)) return "Needs attention";
  if (skill.availableDigest)
    return skill.cancelledDigest === skill.availableDigest ? "Update paused" : "Update available";
  return skill.bindings.length ? "Files ready" : "Saved to library";
}
export function skillFailure(skill: ManagedSkill) {
  return skill.failureReason ? skillFailureMessage(skill.failureReason) : skill.failure;
}
export function skillRows(data: SkillSnapshot, search = "", filter: SkillFilter = "all") {
  const managed = data.skills.map((skill) => ({
    kind: "managed" as const,
    key: skill.id,
    name: skill.name,
    skill,
  }));
  const discovered = data.discovered.map((skill) => ({
    kind: "discovered" as const,
    key: skill.identity ?? skill.path,
    name: skill.name,
    skill,
  }));
  const rows = [...managed, ...discovered];
  const counts = {
    all: rows.length,
    unmanaged: discovered.filter((row) => !row.skill.external).length,
    updates: managed.filter((row) => row.skill.availableDigest !== null).length,
    attention: managed.filter((row) => skillAttention(row.skill)).length,
  };
  const needle = search.trim().toLocaleLowerCase();
  return {
    counts,
    rows: rows
      .filter((row) => {
        const words =
          row.kind === "managed"
            ? [
                row.skill.name,
                row.skill.description,
                row.skill.sourceLabel,
                row.skill.locator,
                ...row.skill.bindings.flatMap((target) => [target.label, target.directory]),
              ]
            : [
                row.skill.name,
                row.skill.description,
                row.skill.path,
                row.skill.provider,
                row.skill.origin?.locator,
                ...(row.skill.providers ?? []),
                ...(row.skill.paths ?? []),
              ];
        return (
          words.join(" ").toLocaleLowerCase().includes(needle) &&
          (filter === "all" ||
            (filter === "unmanaged"
              ? row.kind === "discovered" && !row.skill.external
              : row.kind === "managed" &&
                (filter === "updates"
                  ? row.skill.availableDigest !== null
                  : skillAttention(row.skill))))
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key)),
  };
}
export function skillNextCheck(skill: ManagedSkill) {
  if (skill.policy === "manual" || skill.policy === "pinned" || skill.snapshotOnly) return null;
  const previous = Math.max(
    Date.parse(skill.checkedAt ?? "") || 0,
    Date.parse(skill.lastAttemptAt ?? "") || 0,
  );
  return previous ? DateTime.formatIso(DateTime.makeUnsafe(previous + 86400000)) : null;
}

export const skillJobNames: Record<SkillAction["type"], string> = {
  install: "Install",
  adopt: "Adopt",
  check: "Check updates",
  update: "Apply update",
  rollback: "Restore and pin",
  remove: "Uninstall",
  unmanage: "Stop managing",
  resolve: "Resolve local changes",
  select: "Choose a skill",
  origin: "Connect update source",
  policy: "Change policy",
  configure: "Configure locations",
  cancel: "Cancel pending update",
  refresh: "Refresh discoveries",
  "source.check": "Check availability",
  "source.prepare": "Prepare installer",
  "source.save": "Save source",
  "source.remove": "Remove source",
  "target.save": "Save location",
  "target.remove": "Remove location",
};

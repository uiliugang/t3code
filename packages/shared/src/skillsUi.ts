import type { SkillAction } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  skillFailureMessage,
  type ManagedSkill,
  type SkillMutation,
  type SkillSnapshot,
  type SkillSource,
  type SkillUpdatePolicy,
  type SkillTarget,
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
  managed: "Managed",
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
export function skillSourceFailure(data: SkillSnapshot) {
  if (!data.lastFailure || !data.lastFailureReason) return;
  return data.sources.find(
    (source) =>
      source.health?.reason === data.lastFailureReason &&
      source.health?.detail === (data.lastFailureDiagnostics || data.lastFailure),
  );
}
function skillAttention(skill: ManagedSkill) {
  return (
    skill.status === "failed" ||
    Boolean(skill.failureReason) ||
    (Boolean(skill.snapshotOnly) && (skill.policy === "automatic" || skill.policy === "notify")) ||
    skill.bindings.some((target) => target.status === "conflict")
  );
}
export function skillStatus(skill: ManagedSkill) {
  if (skill.failureReason === "select-skill" && skill.choices?.length)
    return "Choose skills to install";
  if (skill.status === "fetching") return "Downloading package";
  if (skill.status === "removing") return "Removing";
  if (skill.status === "pending") return "Waiting for idle agents";
  if (skillAttention(skill)) return "Needs attention";
  if (skill.availableDigest)
    return skill.cancelledDigest === skill.availableDigest ? "Update paused" : "Update available";
  return skill.bindings.length ? "Files ready" : "Saved to library";
}
export function skillFailure(skill: ManagedSkill) {
  if (skill.failureReason === "select-skill" && skill.choices?.length) return null;
  return skill.failureReason ? skillFailureMessage(skill.failureReason) : skill.failure;
}
export function skillRows(
  data: SkillSnapshot,
  search = "",
  filter: SkillFilter = "all",
  showExternal = false,
) {
  const managed = data.skills.map((skill) => ({
    kind: "managed" as const,
    key: skill.id,
    name: skill.name,
    skill,
  }));
  const discovered = data.discovered
    .filter((skill) => showExternal || !skill.external)
    .map((skill) => ({
      kind: "discovered" as const,
      key: skill.identity ?? skill.path,
      name: skill.name,
      skill,
    }));
  const rows = [...managed, ...discovered];
  const counts = {
    all: rows.length,
    managed: managed.length,
    unmanaged: discovered.filter((row) => !row.skill.external).length,
    updates: managed.filter((row) => row.skill.availableDigest !== null).length,
    attention: managed.filter((row) => skillAttention(row.skill)).length,
  };
  const needle = search.trim().toLocaleLowerCase();
  return {
    counts,
    hiddenExternal: showExternal ? 0 : data.discovered.filter((skill) => skill.external).length,
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
                (filter === "managed" ||
                  (filter === "updates"
                    ? row.skill.availableDigest !== null
                    : skillAttention(row.skill)))))
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key)),
  };
}

export function skillDefaultTargetIds(
  targets: ReadonlyArray<SkillTarget>,
  originalIds: ReadonlyArray<string> = [],
) {
  return targets
    .filter(
      (target) =>
        target.enabled !== false &&
        (target.id === "directory:shared" || originalIds.includes(target.id)),
    )
    .map((target) => target.id);
}

export function skillTargetGroups(targets: ReadonlyArray<SkillTarget>) {
  const groups = new Map<string, { directory: string; targets: SkillTarget[] }>();
  for (const target of targets) {
    const group = groups.get(target.directory);
    if (group) group.targets.push(target);
    else groups.set(target.directory, { directory: target.directory, targets: [target] });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    enabled: group.targets.every((target) => target.enabled !== false),
    hasSkills: group.targets.some((target) => target.hasSkills),
    shared: group.targets.some((target) => target.id === "directory:shared"),
  }));
}

export function skillGroups(rows: ReturnType<typeof skillRows>["rows"]) {
  const groups = new Map<string, { key: string; name: string; rows: typeof rows }>();
  for (const row of rows) {
    const origin = row.kind === "managed" ? row.skill : row.skill.origin;
    const externalRoot =
      row.kind === "discovered" && row.skill.external
        ? row.skill.path
            .replaceAll("\\", "/")
            .match(/^(.*\/(?:plugins\/cache\/[^/]+\/[^/]+\/[^/]+|\.system))\//)?.[1]
        : undefined;
    const key = origin
      ? JSON.stringify([origin.sourceId, origin.locator])
      : (externalRoot ?? row.key);
    const locator = origin?.locator ?? externalRoot ?? row.name;
    const label =
      externalRoot && !externalRoot.endsWith("/.system")
        ? (externalRoot.split("/").at(-2) ?? locator)
        : locator;
    const name =
      label
        .replace(/\/$/, "")
        .split(/[/\\]/)
        .at(-1)
        ?.replace(/\.git$/, "") || row.name;
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { key, name, rows: [row] });
  }
  return [...groups.values()];
}

export function skillSelection(skill: ManagedSkill, choices: ReadonlyArray<string>): SkillMutation {
  return {
    type: "batch",
    operations: [...new Set(choices)].map((choice, index) =>
      index === 0
        ? { type: "select", id: skill.id, skill: choice }
        : {
            type: "install",
            sourceId: skill.sourceId,
            locator: skill.locator,
            skill: choice,
            targetIds: skill.bindings.map((target) => target.id),
            policy: skill.policy,
          },
    ),
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
  copy: "Copy skill",
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
  "target.configure": "Configure location",
};

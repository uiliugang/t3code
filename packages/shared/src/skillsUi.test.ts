import { describe, expect, it } from "vite-plus/test";
import type { ManagedSkill, SkillSnapshot, SkillJob } from "@t3tools/contracts";
import {
  skillGroups,
  skillRows,
  skillSelection,
  skillTargetGroups,
  skillDefaultTargetIds,
  skillBindingTargetIds,
  skillBatchBindingOperations,
  skillFailure,
  skillConfigurationJob,
  skillStatus,
  skillSourceFailure,
} from "./skillsUi.ts";

const skill: ManagedSkill = {
  id: "review",
  name: "review",
  description: "Review changes",
  sourceId: "local",
  sourceLabel: "Local import",
  locator: "/team",
  requestedSkill: "review",
  versions: [],
  activeDigest: null,
  availableDigest: null,
  bindings: [],
  policy: "automatic",
  status: "ready",
  failure: null,
  checkedAt: null,
};
const snapshot: SkillSnapshot = {
  sources: [],
  skills: [skill],
  customTargets: [],
  targets: [],
  operation: null,
  lastFailure: null,
  discovered: [
    {
      name: "external",
      path: "/plugins/skills/external/SKILL.md",
      provider: "Codex",
      external: true,
    },
    { name: "local", path: "/skills/local/SKILL.md", provider: "Codex" },
  ],
};

describe("skill management views", () => {
  it("keeps configuration failures only while they match the current skill error", () => {
    const job: SkillJob = {
      id: "configure-review",
      input: { type: "configure", id: skill.id, policy: "automatic", targetIds: [] },
      origin: "user",
      status: "failed",
      reason: "conflict",
      createdAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(skillConfigurationJob({ ...skill, failureReason: "conflict" }, [job])).toBe(job);
    expect(skillConfigurationJob({ ...skill, failureReason: null }, [job])).toBeUndefined();
    expect(skillConfigurationJob(skill, [{ ...job, reason: null }])).toBeUndefined();
    expect(
      skillConfigurationJob({ ...skill, failureReason: "local-changes" }, [job]),
    ).toBeUndefined();
    const queued = { ...job, id: "retry", status: "queued" as const, reason: null };
    expect(skillConfigurationJob(skill, [job, queued])).toBe(queued);
    expect(skillConfigurationJob({ ...skill, id: "other" }, [job])).toBeUndefined();
    expect(skillConfigurationJob(skill)).toBeUndefined();
  });

  it("does not flag snapshots without update requirements as needing attention", () => {
    for (const policy of ["manual", "pinned"] as const) {
      const current = { ...skill, snapshotOnly: true, policy };
      expect(skillStatus(current)).toBe("Saved to library");
      expect(skillRows({ ...snapshot, skills: [current] }).counts.attention).toBe(0);
    }
  });

  it("keeps matching source failures local without hiding unrelated errors", () => {
    const failed: SkillSnapshot = {
      ...snapshot,
      lastFailure: "The installer failed",
      lastFailureReason: "installer-failed",
      lastFailureDiagnostics: "Installer exited with code 1",
      sources: [
        {
          id: "community",
          label: "Git / HTTP",
          kind: "skills",
          enabled: true,
          executable: "",
          registry: "",
          health: {
            checkedAt: "2026-01-01T00:00:00.000Z",
            reason: "installer-failed",
            detail: "Installer exited with code 1",
          },
        },
      ],
    };
    expect(skillSourceFailure(failed)?.id).toBe("community");
    expect(skillSourceFailure({ ...failed, lastFailureReason: "io" })).toBeUndefined();
    expect(
      skillSourceFailure({ ...failed, lastFailureDiagnostics: "A different failure" }),
    ).toBeUndefined();
    expect(skillSourceFailure({ ...failed, lastFailure: null })).toBeUndefined();
    expect(
      skillSourceFailure({
        ...failed,
        lastFailure: "Installer exited with code 1",
        lastFailureDiagnostics: null,
      })?.id,
    ).toBe("community");
  });

  it("hides external skills by default and keeps counts consistent with visible ownership", () => {
    expect(skillRows(snapshot).rows.map((row) => row.name)).toEqual(["local", "review"]);
    expect(skillRows(snapshot).counts).toEqual({
      all: 2,
      managed: 1,
      unmanaged: 1,
      updates: 0,
      attention: 0,
    });
    expect(skillRows(snapshot, "", "managed", true).rows.map((row) => row.key)).toEqual([skill.id]);
    expect(skillRows(snapshot, "external", "managed", true).rows).toHaveLength(0);
    expect(skillRows(snapshot, "review", "managed").rows.map((row) => row.key)).toEqual([skill.id]);
    const failed = {
      ...skill,
      id: "failed",
      status: "failed" as const,
      failureReason: "conflict" as const,
    };
    const managed = skillRows({ ...snapshot, skills: [skill, failed] }, "", "managed");
    expect(managed.counts.managed).toBe(2);
    expect(managed.rows.map((row) => row.key)).toEqual([failed.id, skill.id]);
    expect(skillRows(snapshot, "", "all", true).rows).toHaveLength(3);
    expect(skillRows(snapshot, "external").rows).toHaveLength(0);
    expect(skillRows(snapshot, "external", "all", true).rows).toHaveLength(1);
    const sourced = {
      ...snapshot,
      discovered: snapshot.discovered.map((entry) =>
        entry.name === "local"
          ? {
              ...entry,
              origin: {
                sourceId: "community",
                locator: "owner/repo",
                skill: "local",
                evidence: "git",
              },
            }
          : entry,
      ),
    };
    expect(skillRows(sourced, "", "all", false, "local").rows.map((row) => row.name)).toEqual([
      "review",
    ]);
    expect(skillRows(sourced, "", "all", false, "community").rows.map((row) => row.name)).toEqual([
      "local",
    ]);
    expect(skillRows(sourced, "", "managed", false, "community").rows).toHaveLength(0);
    expect(skillRows(sourced, "missing", "all", false, "community").rows).toHaveLength(0);
    expect(skillRows(sourced, "", "all", false, "").rows).toHaveLength(0);
    expect(skillRows(sourced, "", "all", true, "").rows.map((row) => row.name)).toEqual([
      "external",
    ]);
    const inheritedId = {
      ...snapshot,
      skills: [{ ...skill, sourceId: "constructor" }],
      discovered: [],
    };
    expect(skillRows(inheritedId).sourceCounts["constructor"]).toBe(1);
    expect(skillRows(inheritedId, "", "all", false, "constructor").rows).toHaveLength(1);
  });

  it("groups a package by its source while retaining independent children", () => {
    const second = { ...skill, id: "debugging", name: "debugging", requestedSkill: "debugging" };
    const groups = skillGroups(
      skillRows({ ...snapshot, discovered: [], skills: [skill, second] }).rows,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows.map((row) => row.name)).toEqual(["debugging", "review"]);
    expect(
      skillGroups(
        skillRows({
          ...snapshot,
          discovered: [],
          skills: [skill, { ...second, locator: "/other" }],
        }).rows,
      ),
    ).toHaveLength(2);
  });

  it("merges directory instances and preserves all target ids", () => {
    const targets = [
      { id: "codex", label: "Codex", directory: "/skills" },
      { id: "chatgpt", label: "ChatGPT", directory: "/skills" },
      { id: "claude", label: "Claude", directory: "/claude" },
    ];
    expect(
      skillTargetGroups(targets).map((group) => [group.directory, group.targets.map((t) => t.id)]),
    ).toEqual([
      ["/skills", ["codex", "chatgpt"]],
      ["/claude", ["claude"]],
    ]);
    const available = [
      ...targets,
      { id: "directory:shared", label: "Shared", directory: "/shared" },
      { id: "disabled", label: "Disabled", directory: "/disabled", enabled: false },
    ];
    expect(skillDefaultTargetIds(available)).toEqual(["directory:shared"]);
    expect(skillDefaultTargetIds(available, ["claude", "disabled", "missing"])).toEqual([
      "claude",
      "directory:shared",
    ]);
    expect(skillDefaultTargetIds(targets)).toEqual([]);
    expect(skillDefaultTargetIds([{ ...available[3]!, enabled: false }])).toEqual([]);
    expect(
      skillBindingTargetIds(available, [
        { directory: "/skills" },
        { directory: "/skills" },
        { directory: "/removed-account" },
        { directory: "/disabled" },
      ]),
    ).toEqual(["codex", "chatgpt"]);
    expect(skillBindingTargetIds(available, [])).toEqual([]);
    expect(skillBindingTargetIds(available, [{ directory: "/claude" }])).toEqual(["claude"]);
  });

  it("adds and removes batch locations without replacing each skill's other bindings", () => {
    const targets = [
      { id: "codex", label: "Codex", directory: "/codex" },
      { id: "alias", label: "Codex account", directory: "/codex" },
      { id: "claude", label: "Claude", directory: "/claude" },
      { id: "shared", label: "Shared", directory: "/shared" },
    ];
    const skills: ManagedSkill[] = [
      { ...skill, bindings: [{ ...targets[0]!, status: "linked" }] },
      { ...skill, id: "debug", policy: "pinned", bindings: [{ ...targets[2]!, status: "linked" }] },
    ];
    expect(skillBatchBindingOperations(skills, targets, ["shared", "shared"], "add")).toEqual([
      {
        type: "configure",
        id: "review",
        policy: "automatic",
        targetIds: ["codex", "alias", "shared"],
      },
      { type: "configure", id: "debug", policy: "pinned", targetIds: ["claude", "shared"] },
    ]);
    expect(skillBatchBindingOperations(skills, targets, ["alias"], "remove")).toEqual([
      { type: "configure", id: "review", policy: "automatic", targetIds: [] },
    ]);
    expect(skillBatchBindingOperations(skills, targets, ["codex"], "add")).toEqual([
      { type: "configure", id: "debug", policy: "pinned", targetIds: ["claude", "codex", "alias"] },
    ]);
    const canonicalTargets = targets.map((target) => ({
      ...target,
      directory: `/private${target.directory}`,
    }));
    expect(skillBatchBindingOperations(skills, canonicalTargets, ["shared"], "add")).toEqual(
      skillBatchBindingOperations(skills, targets, ["shared"], "add"),
    );
    expect(skillBatchBindingOperations(skills, canonicalTargets, ["alias"], "remove")).toEqual(
      skillBatchBindingOperations(skills, targets, ["alias"], "remove"),
    );
    expect(skillBatchBindingOperations(skills, targets, [], "remove")).toEqual([]);
    expect(skillBatchBindingOperations(skills, targets, ["missing"], "add")).toEqual([]);
    expect(
      skillBatchBindingOperations(
        skills,
        targets.map((target) => ({ ...target, enabled: false })),
        ["shared"],
        "add",
      ),
    ).toEqual([]);
    const orphan = {
      ...skill,
      bindings: [
        { id: "removed", label: "Removed", directory: "/removed", status: "missing" as const },
      ],
    };
    expect(skillBatchBindingOperations([orphan], targets, ["shared"], "add")).toBeNull();
  });

  it("selects multiple skills without discarding policy or usage locations", () => {
    const selection = {
      ...skill,
      failureReason: "select-skill" as const,
      choices: ["review", "debugging"],
    };
    expect(skillStatus(selection)).toBe("Choose skills to install");
    expect(skillStatus({ ...selection, status: "fetching", failureReason: null })).toBe(
      "Downloading package",
    );
    expect(skillFailure(selection)).toBeNull();
    const input = {
      ...skill,
      bindings: [{ id: "codex", label: "Codex", directory: "/skills", status: "missing" as const }],
    };
    expect(skillSelection(input, ["review", "debugging", "debugging"])).toEqual({
      type: "batch",
      operations: [
        { type: "select", id: "review", skill: "review" },
        {
          type: "install",
          sourceId: "local",
          locator: "/team",
          skill: "debugging",
          targetIds: ["codex"],
          policy: "automatic",
        },
      ],
    });
    expect(skillSelection(input, [])).toEqual({ type: "batch", operations: [] });
  });
});

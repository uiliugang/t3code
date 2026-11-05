import { describe, expect, it } from "vite-plus/test";
import type { ManagedSkill, SkillSnapshot } from "@t3tools/contracts";
import {
  skillGroups,
  skillRows,
  skillSelection,
  skillTargetGroups,
  skillDefaultTargetIds,
  skillFailure,
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

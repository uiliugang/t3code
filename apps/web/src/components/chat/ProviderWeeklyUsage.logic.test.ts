import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { collectProviderWeeklyUsage } from "./ProviderWeeklyUsage.logic";

const checkedAt = "2026-10-28T00:00:00.000Z";
const weekly: ServerProviderUsageWindow = {
  id: "secondary",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 32,
};

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt, windows: [weekly] },
    ...overrides,
  };
}

function summarize(...providers: ServerProvider[]) {
  return collectProviderWeeklyUsage(deriveProviderInstanceEntries(providers));
}

describe("provider weekly usage", () => {
  it("keeps enabled instances and their display names separate", () => {
    const items = summarize(
      provider({ displayName: "Work Codex", accentColor: "#506ad6" }),
      provider({
        instanceId: ProviderInstanceId.make("personal"),
        displayName: "Personal Codex",
        usageLimits: { checkedAt, windows: [{ ...weekly, usedPercent: 18 }] },
      }),
      provider({ instanceId: ProviderInstanceId.make("disabled"), enabled: false }),
    );
    expect(items).toEqual([
      {
        instanceId: "codex",
        displayName: "Work Codex",
        accentColor: "#506ad6",
        remaining: 68,
      },
      {
        instanceId: "personal",
        displayName: "Personal Codex",
        accentColor: undefined,
        remaining: 82,
      },
    ]);
  });

  it("honors project enablement overrides", () => {
    const id = ProjectId.make("project");
    const entries = applyProviderInstanceSettings(
      deriveProviderInstanceEntries([provider()]),
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: {
          [id]: {
            providerInstances: { [ProviderInstanceId.make("codex")]: { enabled: false } },
          },
        },
      },
      id,
    );
    expect(collectProviderWeeklyUsage(entries)).toEqual([]);
  });

  it("prefers overall Codex and Claude weekly quotas to session and model quotas", () => {
    for (const id of ["secondary", "seven_day"]) {
      expect(
        summarize(
          provider({
            usageLimits: {
              checkedAt,
              windows: [
                { ...weekly, id: "primary", kind: "session", usedPercent: 99 },
                { ...weekly, id: "seven_day_fable", usedPercent: 90 },
                { ...weekly, id, usedPercent: 32 },
              ],
            },
          }),
        )[0]?.remaining,
      ).toBe(68);
    }
  });

  it("uses the most constrained weekly quota when no overall window exists", () => {
    expect(
      summarize(
        provider({
          usageLimits: {
            checkedAt,
            windows: [
              { ...weekly, id: "model-a", usedPercent: 12.5 },
              { ...weekly, id: "model-b", usedPercent: 83.6 },
            ],
          },
        }),
      )[0]?.remaining,
    ).toBe(16);
  });

  it("keeps missing, unsupported and non-weekly quotas unknown", () => {
    for (const usageLimits of [
      undefined,
      { checkedAt, windows: [] },
      { checkedAt, windows: [{ ...weekly, kind: "session" as const }] },
      { checkedAt, windows: [{ ...weekly, kind: "monthly" as const }] },
      { checkedAt, windows: [weekly], unavailable: { reason: "unsupported" as const } },
    ]) {
      expect(summarize(provider({ usageLimits }))[0]?.remaining).toBeNull();
    }
  });

  it("retains last reported quotas after a failed probe and preserves zero", () => {
    expect(
      summarize(
        provider({
          usageLimits: {
            checkedAt,
            windows: [{ ...weekly, usedPercent: 100 }],
            unavailable: { reason: "probeFailed" },
          },
        }),
      )[0]?.remaining,
    ).toBe(0);
    expect(
      summarize(
        provider({ usageLimits: { checkedAt, windows: [{ ...weekly, usedPercent: 0 }] } }),
      )[0]?.remaining,
    ).toBe(100);
  });
});

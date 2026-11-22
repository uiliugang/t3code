import { describe, expect, it } from "vite-plus/test";

import {
  meituanToolIdsForSection,
  mepSpaceSummary,
  shouldDiscoverMeituanProjectSources,
} from "./meituanSettings.ts";

describe("Meituan settings sections", () => {
  it("reports an empty MEP association only after discovery succeeds", () => {
    const t = (message: string) => message;
    expect(mepSpaceSummary([], false, "pending", t)).toContain("Loading");
    expect(mepSpaceSummary([], false, "failed", t)).toContain("Unknown");
    expect(mepSpaceSummary([], false, "ready", t)).toBe("No MEP space linked");
    expect(mepSpaceSummary(["42"], true, "failed", t)).toContain("42");
  });
  it("discovers project sources only for the integration overview", () => {
    expect(shouldDiscoverMeituanProjectSources()).toBe(true);
    expect(shouldDiscoverMeituanProjectSources("issues")).toBe(false);
    expect(shouldDiscoverMeituanProjectSources("code")).toBe(false);
    expect(shouldDiscoverMeituanProjectSources("daxiang")).toBe(false);
    expect(shouldDiscoverMeituanProjectSources("skills")).toBe(false);
  });

  it("does not leak tools into DaXiang or disabled service sections", () => {
    const enabled = { code: true, issues: true, skills: true };
    expect(meituanToolIdsForSection("daxiang", enabled)).toEqual([]);
    expect(meituanToolIdsForSection("code", { ...enabled, code: false })).toEqual([]);
    expect(meituanToolIdsForSection("issues", { ...enabled, issues: false })).toEqual([]);
    expect(meituanToolIdsForSection("skills", { ...enabled, skills: false })).toEqual([]);
    expect(meituanToolIdsForSection(undefined, enabled)).toEqual([
      "meituan",
      "ones2",
      "mcm",
      "mtskills",
    ]);
  });
});

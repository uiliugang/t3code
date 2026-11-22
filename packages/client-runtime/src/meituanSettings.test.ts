import { describe, expect, it } from "vite-plus/test";

import {
  meituanToolIdsForSection,
  shouldDiscoverMeituanProjectSources,
} from "./meituanSettings.ts";

describe("Meituan settings sections", () => {
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

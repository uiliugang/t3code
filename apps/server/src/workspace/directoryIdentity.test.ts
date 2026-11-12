import { describe, expect, it } from "@effect/vitest";
import { sameDirectoryIdentity } from "./directoryIdentity.ts";

describe("sameDirectoryIdentity", () => {
  it.each([
    ['["16777229","197871433","1794399590034"]', '["16777230","197871433","1794399590034"]', true],
    ['["16777229","169328590","1793016706290"]', '["16777230","169328590","1793016706290"]', true],
    ['["1","2","1000"]', '["1","3","1000"]', false],
    ['["1","2","1000"]', '["1","2","1001"]', false],
    ['["1","2","1000"]', '["1","2","1002"]', false],
    ['["1","null","1000"]', '["2","null","1000"]', false],
    ['["1","2","null"]', '["2","2","null"]', false],
    ['["1","0","1000"]', '["2","0","1000"]', false],
    ["invalid", "different", false],
    ["opaque", "opaque", true],
  ])("compares %s and %s on macOS", (left, right, expected) => {
    expect(sameDirectoryIdentity(left, right, "darwin")).toBe(expected);
    expect(sameDirectoryIdentity(right, left, "darwin")).toBe(expected);
  });

  it.each(["linux", "win32"] as const)("preserves strict comparison on %s", (platform) => {
    expect(sameDirectoryIdentity('["1","2","1000"]', '["2","2","1000"]', platform)).toBe(false);
    expect(sameDirectoryIdentity('["1","2","1000"]', '["1","2","1001"]', platform)).toBe(false);
  });
});

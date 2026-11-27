import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { unsetInheritedGitRepositoryEnv } from "./gitRepositoryEnv.ts";

describe("git test setup", () => {
  it("starts tests without the repository selectors git exported to the run", async () => {
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    vi.stubEnv("GIT_DIR", "/repo/.git/worktrees/wt");
    vi.stubEnv("GIT_INDEX_FILE", "/repo/.git/worktrees/wt/index");
    vi.stubEnv("GIT_EDITOR", "true");

    vi.resetModules();
    await import("./gitEnv.ts");

    expect(process.env).not.toHaveProperty("GIT_DIR");
    expect(process.env).not.toHaveProperty("GIT_INDEX_FILE");
    expect(process.env.GIT_EDITOR).toBe("true");
  });

  it("leaves non-exact spellings alone on POSIX", () => {
    const inherited = { Git_Dir: "/repo/.git", GIT_EDITOR: "true", PATH: "/bin" };
    expect(Object.keys(unsetInheritedGitRepositoryEnv(inherited, "linux"))).toEqual([]);
  });
});

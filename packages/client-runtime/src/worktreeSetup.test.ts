import { describe, expect, it } from "vite-plus/test";
import type { WorktreeSetupStage } from "@t3tools/contracts";
import { translateUi } from "@t3tools/shared/uiLocale";
import { worktreeFetchLabel } from "./worktreeSetup.ts";

describe("worktree fetch progress", () => {
  it("translates retries at render time and leaves old snapshots and finished stages alone", () => {
    const stage: WorktreeSetupStage = {
      id: "fetch",
      status: "running",
      startedAt: null,
      endedAt: null,
      percent: null,
      detail: null,
      tail: [],
    };
    expect(worktreeFetchLabel(stage, translateUi.bind(null, "zh-CN"))).toBeNull();
    const retry: WorktreeSetupStage = {
      ...stage,
      fetchProgress: {
        remoteRefName: "origin/feature-English",
        attempt: 2,
        maxAttempts: 3,
        retryReason: "network",
      },
    };
    expect(worktreeFetchLabel(retry, translateUi.bind(null, "zh-CN"))).toBe(
      "连接失败，正在重试 origin/feature-English（2/3）",
    );
    expect(worktreeFetchLabel(retry, translateUi.bind(null, "en"))).toBe(
      "Connection failed; retrying origin/feature-English (2/3)",
    );
    expect(
      worktreeFetchLabel({ ...retry, status: "done" }, translateUi.bind(null, "zh-CN")),
    ).toBeNull();
    expect(
      worktreeFetchLabel({ ...retry, status: "failed" }, translateUi.bind(null, "zh-CN")),
    ).toBeNull();
  });
});

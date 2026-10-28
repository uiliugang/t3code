import { EnvironmentId, ThreadId, ExecutionResourceId, RunId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectThreadDiffPanelSelection,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "./diffPanelStore";

describe("diffPanelStore", () => {
  beforeEach(() => {
    useDiffPanelStore.setState({
      selectedRepositoryByThreadKey: {},
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
  });

  it("keeps each repository's diff scope and same-named file selection isolated and removes every scope with its thread", () => {
    const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
    const front = ExecutionResourceId.make("frontend");
    const back = ExecutionResourceId.make("backend");
    const store = useDiffPanelStore.getState();
    store.selectRepository(ref, front);
    store.selectBranchBaseRef(ref, "main");
    store.selectTurn(ref, RunId.make("front-turn"), "src/index.ts");
    store.selectRepository(ref, back);
    store.selectBranchBaseRef(ref, "develop");
    store.selectTurn(ref, RunId.make("back-turn"), "src/index.ts");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref, front),
    ).toMatchObject({ turnId: "front-turn", filePath: "src/index.ts" });
    store.selectGitScope(ref, "branch");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref, back),
    ).toEqual({ kind: "branch", baseRef: "develop" });
    store.selectRepository(ref, front);
    store.selectGitScope(ref, "branch");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, ref, front),
    ).toEqual({ kind: "branch", baseRef: "main" });
    store.removeThread(ref);
    expect(useDiffPanelStore.getState().byThreadKey).toEqual({});
    expect(useDiffPanelStore.getState().branchBaseRefByThreadKey).toEqual({});
    expect(useDiffPanelStore.getState().selectedRepositoryByThreadKey).toEqual({});
  });

  it("retains fold choices when a panel consumer returns with fresh defaults", () => {
    const scopeKey = "environment-1:thread-1:branch";
    const defaults = new Set(["src/app.ts", "src/index.ts"]);
    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, defaults, (current) => {
      const next = new Set(current);
      next.delete("src/app.ts");
      return next;
    });

    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(["src/index.ts"]),
    );

    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, new Set(), (current) => {
      const next = new Set(current);
      next.delete("src/index.ts");
      return next;
    });
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );

    useDiffPanelSessionStore
      .getState()
      .updateCollapsedFileKeys(scopeKey, defaults, (current) => current);
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );
    expect(defaults).toEqual(new Set(["src/app.ts", "src/index.ts"]));
  });
});

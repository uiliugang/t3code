import {
  EnvironmentId,
  ThreadId,
  ProjectId,
  WorkspaceRevisionId,
  WorkspaceRootId,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { useWorktreeSetup } from "./useWorktreeSetup";

const state = vi.hoisted(() => ({ snapshot: null as WorktreeSetupSnapshot | null }));
const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("group-thread"),
};
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: unknown) => ({ data: query === null ? undefined : state.snapshot }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

function setup() {
  state.snapshot = {
    threadId: ThreadId.make("group-thread"),
    phase: "running",
    startedAt: "2026-11-02T00:00:00.000Z",
    endedAt: null,
    branch: "feature",
    baseRef: "main",
    worktreePath: "/isolated/primary",
    setupScript: null,
    stages: [
      {
        id: "agent",
        status: "done",
        startedAt: null,
        endedAt: null,
        percent: null,
        detail: null,
        tail: [],
      },
    ],
    error: null,
    sequence: 1,
  };
}

function SetupProgress({
  grouped,
  preparing = false,
  unbound = false,
}: {
  grouped: boolean;
  preparing?: boolean;
  unbound?: boolean;
}) {
  const ref = threadRef;
  const activeThread = {
    id: ref.threadId,
    worktreePath: grouped || unbound ? null : "/isolated/primary",
    workspace: unbound
      ? undefined
      : {
          mode: "isolated" as const,
          id: WorkspaceRevisionId.make("workspace"),
          projectId: ProjectId.make("project"),
          sourceProjectVersion: 1,
          previousRevisionId: null,
          primaryRootId: WorkspaceRootId.make("primary"),
          resources: [],
          bindings: [],
          createdAt: "2026-11-02T00:00:00.000Z",
        },
  };
  const { worktreeSetup, blocksSend } = useWorktreeSetup({
    routeThreadRef: ref,
    ownerKey: "group-thread",
    activeThread,
    threadRef: ref,
    serverProjection: null,
    activityRun: null,
    localPreparing: preparing,
    sendQueuesBehindSetup: false,
    followUpSent: false,
  });
  return (
    <output>
      {worktreeSetup?.phase ?? "missing"}:{blocksSend ? "blocked" : "ready"}
    </output>
  );
}

it.each([true, false])(
  "keeps async setup visible when reopening a grouped=%s thread after handoff",
  async (grouped) => {
    setup();
    await using screen = await render(<SetupProgress grouped={grouped} />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("running:ready");
  },
);

it("receives the final setup state after an unbound workspace stops preparing", async () => {
  setup();
  state.snapshot = { ...state.snapshot!, stages: [] };
  await using screen = await render(<SetupProgress grouped={false} preparing unbound />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("running:blocked");
  state.snapshot = { ...state.snapshot!, phase: "failed", sequence: 2 };
  await screen.rerender(<SetupProgress grouped={false} unbound />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("failed:ready");
});

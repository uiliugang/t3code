import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  matchComposerEnvironmentItems,
  matchComposerThreadItems,
  type ComposerThreadCandidate,
} from "./composerThreadItems.ts";

const environmentId = EnvironmentId.make("env-composer");

function shell(
  id: string,
  title: string,
  overrides: Partial<ComposerThreadCandidate> = {},
): ComposerThreadCandidate {
  return {
    environmentId,
    id: ThreadId.make(id),
    title,
    branch: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    latestUserMessageAt: null,
    opens: null,
    archivedAt: null,
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    ...overrides,
  };
}

it("ranks thread mentions like the palette and leaves out subagent threads", () => {
  const items = matchComposerThreadItems({
    shells: [
      shell("newer-mid-word", "Remodel the settings page", {
        updatedAt: "2026-10-20T00:00:00.000Z",
      }),
      shell("word", "Fix model picker"),
      shell("subagent", "Model review", {
        lineage: {
          rootThreadId: ThreadId.make("word"),
          parentThreadId: ThreadId.make("word"),
          relationshipToParent: "subagent",
        },
      }),
      shell("other-environment", "Model docs", { environmentId: EnvironmentId.make("env-other") }),
    ],
    environmentId,
    linkedEnvironments: new Map(),
    excludeThreadId: null,
    query: "model",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map((item) => item.thread.threadId)).toEqual(["word", "newer-mid-word"]);
});

it("offers the composer thread's own used side chats, but not other threads' side chats", () => {
  const sideChatOf = (parent: string) => ({
    rootThreadId: ThreadId.make(parent),
    parentThreadId: ThreadId.make(parent),
    relationshipToParent: "fork" as const,
    sideChat: true,
  });
  const latestUserMessageAt = "2026-10-22T00:00:00.000Z";
  const items = matchComposerThreadItems({
    shells: [
      shell("mine", "Why is the build slow?", { lineage: sideChatOf("main"), latestUserMessageAt }),
      shell("unused", "Slow side chat", { lineage: sideChatOf("main") }),
      shell("theirs", "Why is the test slow?", {
        lineage: sideChatOf("other"),
        latestUserMessageAt,
      }),
    ],
    environmentId,
    linkedEnvironments: new Map(),
    excludeThreadId: ThreadId.make("main"),
    query: "slow",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map(({ thread, description }) => ({ id: thread.threadId, description }))).toEqual([
    { id: "mine", description: "Local machine · Side chat · Ready · Last active 1d ago" },
  ]);
});

it("also offers threads on linked machines, naming the machine, but no other machine's", () => {
  const vps = EnvironmentId.make("env-vps");
  const items = matchComposerThreadItems({
    shells: [
      shell("here", "Deploy script"),
      shell("there", "Deploy script", {
        environmentId: vps,
        latestRun: {
          runId: RunId.make("run-deploy"),
          status: "completed",
          requestedAt: "2026-10-22T20:00:00.000Z",
          startedAt: "2026-10-22T20:01:00.000Z",
          completedAt: "2026-10-22T23:50:00.000Z",
          assistantMessageId: null,
        },
      }),
      shell("working", "Deploy script", {
        environmentId: vps,
        updatedAt: "2026-10-22T23:59:00.000Z",
        latestUserMessageAt: "2026-10-22T20:00:00.000Z",
        runtime: {
          status: "running",
          activeRunId: RunId.make("run-working"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-10-22T23:59:00.000Z",
        },
        latestRun: {
          runId: RunId.make("run-working"),
          status: "running",
          requestedAt: "2026-10-22T20:00:00.000Z",
          startedAt: "2026-10-22T20:01:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
      shell("unlinked", "Deploy notes", { environmentId: EnvironmentId.make("env-unlinked") }),
    ],
    environmentId,
    environmentLabel: "Gmac Air",
    linkedEnvironments: new Map([[vps, "Hetzner VPS"]]),
    excludeThreadId: null,
    query: "deploy",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map(({ thread, label, description }) => ({ thread, label, description }))).toEqual([
    {
      thread: { environmentId: vps, threadId: "working" },
      label: "Deploy script",
      description: "Hetzner VPS · Running · Last active 1m ago",
    },
    {
      thread: { environmentId, threadId: "here" },
      label: "Deploy script",
      description: "Gmac Air · Ready · Created 22d ago",
    },
    {
      thread: { environmentId: vps, threadId: "there" },
      label: "Deploy script",
      description: "Hetzner VPS · Completed · Last active 10m ago",
    },
  ]);
});

it.each([
  ["running", { hasPendingApprovals: true, hasPendingUserInput: true }, "Needs approval"],
  ["running", { hasPendingUserInput: true }, "Needs input"],
  ["running", { pendingSubagentRequest: "approval" }, "Needs approval"],
  ["running", { pendingSubagentRequest: "user_input" }, "Needs input"],
  ["running", { blockedOnThreadWait: true }, "Waiting"],
] as const)("shows %s with %o as %s", (status, overrides, label) => {
  const items = matchComposerThreadItems({
    shells: [
      shell("deploy", "Deploy script", {
        runtime: {
          status,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
        ...overrides,
      }),
    ],
    environmentId,
    linkedEnvironments: new Map(),
    excludeThreadId: null,
    query: "deploy",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items[0]?.description).toBe(`Local machine · ${label} · Created 22d ago`);
});

describe("matchComposerEnvironmentItems", () => {
  const environments = [
    { environmentId: EnvironmentId.make("env-here"), label: "Laptop", machine: "laptop" },
    { environmentId: EnvironmentId.make("env-vps"), label: "Hetzner VPS", machine: "cloud" },
    { environmentId: EnvironmentId.make("env-mini"), label: "Mac mini", machine: "mac-mini" },
  ] as const;

  it("offers the other machines matching the query, never the composer's own", () => {
    expect(
      matchComposerEnvironmentItems({
        environments,
        environmentId: EnvironmentId.make("env-here"),
        query: "  vps ",
      }),
    ).toEqual([
      {
        id: "environment:env-vps",
        type: "environment",
        environmentId: "env-vps",
        machine: "cloud",
        label: "Hetzner VPS",
        description: "Machine",
      },
    ]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        environmentId: EnvironmentId.make("env-here"),
        query: "lap",
      }),
    ).toEqual([]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        environmentId: EnvironmentId.make("env-here"),
        query: "",
      }),
    ).toEqual([]);
  });
});

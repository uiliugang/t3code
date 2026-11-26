import type { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, SourceControlProviderKind, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  canStartThreadPullRequestWatch,
  canWatchLinkedPullRequest,
  planThreadPullRequestMutation,
  threadPullRequestLinkMode,
} from "./threadPullRequestCompatibility.ts";

const reference = {
  host: "github.example",
  repository: "team/repo",
  number: 7,
  url: "https://github.example/team/repo/pull/7",
};
const input = {
  threadId: ThreadId.make("thread"),
  reference,
  linked: true,
};
const capabilities = { repositoryIdentity: true } satisfies ExecutionEnvironmentCapabilities;

describe("thread pull request capability negotiation", () => {
  it.each([true, false])(
    "preserves Forgejo ports in a multi-link mutation: linked=%s",
    (linked) => {
      const mutation = planThreadPullRequestMutation({
        ...input,
        linked,
        capabilities,
        reference: {
          host: "forge.example",
          repository: "team/repo",
          number: 7,
          url: "http://forge.example:3000/team/repo/pulls/7",
        },
      });
      expect(mutation).toMatchObject({ input: { host: "forge.example:3000", number: 7 } });
    },
  );

  it("does not dispatch before the server config loads", () => {
    expect(threadPullRequestLinkMode(undefined)).toBe("unsupported");
    expect(planThreadPullRequestMutation({ ...input, capabilities: undefined })).toBeNull();
  });
  it("plans link and unlink commands", () => {
    const target = { provider: "github", origin: "https://github.example" };
    expect(planThreadPullRequestMutation({ ...input, capabilities })).toEqual({
      type: "thread.pull-request.link",
      input: { threadId: input.threadId, ...reference, target, source: "manual" },
    });
    expect(planThreadPullRequestMutation({ ...input, capabilities, linked: false })).toEqual({
      type: "thread.pull-request.unlink",
      input: {
        threadId: input.threadId,
        host: reference.host,
        repository: reference.repository,
        number: reference.number,
        target,
      },
    });
  });

  it("offers a new watch only where the server accepts one", () => {
    const active = {
      archivedAt: null,
      settledAt: null,
      settledOverride: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
    } as const;
    expect(canStartThreadPullRequestWatch(active)).toBe(true);
    expect(canStartThreadPullRequestWatch({ ...active, settledOverride: "active" })).toBe(true);
    expect(canStartThreadPullRequestWatch({ ...active, settledOverride: "settled" })).toBe(false);
    expect(canStartThreadPullRequestWatch({ ...active, settledAt: "2026-01-01T00:00:00Z" })).toBe(
      false,
    );
    expect(canStartThreadPullRequestWatch({ ...active, archivedAt: "2026-01-01T00:00:00Z" })).toBe(
      false,
    );
    expect(
      canStartThreadPullRequestWatch({
        ...active,
        lineage: { ...active.lineage, relationshipToParent: "subagent" },
      }),
    ).toBe(false);
  });

  it("requires a known matching GitLab source for a new legacy watch, but lets users stop it", () => {
    const thread = {
      archivedAt: null,
      settledAt: null,
      settledOverride: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
    } as const;
    const link = { url: "http://forge.test/team/repo/-/merge_requests/7", snapshot: null };
    const project = (remoteUrl: string) => ({
      id: ProjectId.make("project"),
      environmentId: EnvironmentId.make("environment"),
      repositoryIdentity: {
        canonicalKey: "forge.test/team/repo",
        displayName: "team/repo",
        provider: SourceControlProviderKind.make("gitlab"),
        locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl },
      },
    });
    const legacy = { ...capabilities, threadPullRequestWatch: true };
    const ssh = project("git@forge.test:team/repo.git");
    expect(canWatchLinkedPullRequest({ capabilities: legacy, thread, project: ssh, link })).toBe(
      false,
    );
    expect(
      canWatchLinkedPullRequest({
        capabilities: legacy,
        thread,
        project: project("https://forge.test/team/repo.git"),
        link,
      }),
    ).toBe(false);
    expect(
      canWatchLinkedPullRequest({
        capabilities: legacy,
        thread,
        project: project("http://forge.test/team/repo.git"),
        link,
      }),
    ).toBe(true);
    expect(
      canWatchLinkedPullRequest({
        capabilities: { ...legacy, pullRequestWebTargets: true },
        thread,
        project: ssh,
        link,
      }),
    ).toBe(true);
    const startedAt = "2026-01-01T00:00:00Z";
    const watch = {
      startedAt,
      headSha: null,
      failedChecks: [],
      passed: false,
      passedChecks: [],
      remarksThrough: startedAt,
      remarkIds: [],
      conflicting: false,
      wakes: 0,
    };
    expect(
      canWatchLinkedPullRequest({
        capabilities: legacy,
        thread: { ...thread, settledAt: startedAt },
        project: ssh,
        link: { ...link, watch },
      }),
    ).toBe(true);
  });
});

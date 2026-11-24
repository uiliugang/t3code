import {
  CommandId,
  IssueTrackerKind,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadIssueService from "./ThreadIssueService.ts";

const THREAD_ID = ThreadId.make("thread-1");

describe("ThreadIssueService", () => {
  it.effect("fails an unlink whose thread cannot be read instead of reporting it unlinked", () =>
    Effect.gen(function* () {
      const service = yield* ThreadIssueService.ThreadIssueService;
      const error = yield* service
        .unlink({
          threadId: THREAD_ID,
          key: {
            tracker: IssueTrackerKind.make("github"),
            host: "github.com",
            scope: "t3tools/t3code",
            key: "7",
          },
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OrchestratorProjectionError", threadId: THREAD_ID });
    }).pipe(
      Effect.provide(
        ThreadIssueService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              SqlitePersistence.layerMemory,
              Layer.mock(Orchestrator.OrchestratorV2)({
                getThreadShell: (threadId) =>
                  Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
              }),
              Layer.succeed(
                SecureRandom.SecureRandom,
                SecureRandom.make((size) => new Uint8Array(size).fill(7)),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "rejects an ambiguous URL-less unlink when multiple Linear workspaces match the key",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("codex");
        const modelSelection = { instanceId, model: "gpt-5.1-codex" };
        const adapter = {
          instanceId,
          driver: ProviderDriverKind.make("codex"),
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
          openSession: () => Effect.die("unused"),
        } as ProviderAdapter.ProviderAdapterV2["Service"];
        const layer = ProviderReplayHarness.layerWithRegistry(
          { name: "ambiguous-issue-unlink" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { runEffectWorker: false },
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const tracker = IssueTrackerKind.make("linear");
          const projectId = ProjectId.make("project-1");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd:create"),
            threadId: THREAD_ID,
            projectId,
            title: "Thread",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          for (const [id, workspace] of [
            ["1", "acme"],
            ["2", "globex"],
          ] as const) {
            yield* orchestrator.dispatch({
              type: "thread.issue.link",
              commandId: CommandId.make(`cmd:link:${id}`),
              threadId: THREAD_ID,
              tracker,
              host: "linear.app",
              scope: "ENG",
              key: "ENG-1",
              projectId,
              url: `https://linear.app/${workspace}/issue/ENG-1`,
              displayKey: "ENG-1",
              title: workspace,
              source: "manual",
            });
          }

          const rejected = yield* orchestrator
            .dispatch({
              type: "thread.issue.unlink",
              commandId: CommandId.make("cmd:unlink:ambiguous"),
              threadId: THREAD_ID,
              tracker,
              host: "linear.app",
              scope: "ENG",
              key: "ENG-1",
            })
            .pipe(Effect.flip);
          expect(rejected._tag).toBe("OrchestratorDispatchError");
          const shell = yield* orchestrator.getThreadShell(THREAD_ID);
          expect(shell?.issues).toHaveLength(2);

          // Even with one Linear link left, a URL-less unlink cannot prove which workspace the
          // caller was viewing and must be rejected.
          yield* orchestrator.dispatch({
            type: "thread.issue.unlink",
            commandId: CommandId.make("cmd:unlink:globex"),
            threadId: THREAD_ID,
            tracker,
            host: "linear.app",
            scope: "ENG",
            key: "ENG-1",
            url: "https://linear.app/globex/issue/ENG-1",
          });
          expect((yield* orchestrator.getThreadShell(THREAD_ID))?.issues).toHaveLength(1);
          const rejectedSingle = yield* orchestrator
            .dispatch({
              type: "thread.issue.unlink",
              commandId: CommandId.make("cmd:unlink:single-urlless"),
              threadId: THREAD_ID,
              tracker,
              host: "linear.app",
              scope: "ENG",
              key: "ENG-1",
            })
            .pipe(Effect.flip);
          expect(rejectedSingle._tag).toBe("OrchestratorDispatchError");
          expect((yield* orchestrator.getThreadShell(THREAD_ID))?.issues).toHaveLength(1);
        }).pipe(Effect.provide(layer));
      }),
  );
});

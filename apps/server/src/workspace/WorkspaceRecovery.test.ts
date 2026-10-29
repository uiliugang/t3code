import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ProviderSessionId, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import { emptyProjection } from "../orchestration-v2/ProjectionStore.ts";
import { planWorkspaceBinding } from "../orchestration-v2/WorkspaceBinding.ts";
import {
  workspaceFixture,
  workspaceThreadFixture,
} from "../orchestration-v2/testkit/workspaceFixtures.ts";
import * as WorkspaceRepositoryResolver from "./WorkspaceRepositoryResolver.ts";
import * as WorkspaceRecovery from "./WorkspaceRecovery.ts";
import { RestoreJournal } from "./WorkspaceRestore.ts";

const encodeJournal = Schema.encodeEffect(Schema.fromJsonString(RestoreJournal));
const decodeJournal = Schema.decodeEffect(Schema.fromJsonString(RestoreJournal));

it.effect(
  "keeps recovery frozen until a new revision commits and resumes an interrupted binding with the same revision",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const workspace = workspaceFixture();
      const thread = workspaceThreadFixture(workspace);
      const projection = yield* Ref.make(
        emptyProjection({
          type: "thread.created",
          id: EventId.make("created"),
          threadId: thread.id,
          occurredAt: thread.createdAt,
          payload: thread,
        }),
      );
      const initial = yield* Ref.get(projection);
      yield* Ref.set(projection, {
        ...initial,
        providerSessions: [
          {
            id: ProviderSessionId.make("shared-codex-session"),
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: thread.providerInstanceId,
            status: "ready",
            cwd: workspace.resources[0]!.checkoutRoot,
            model: "test",
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            lastError: null,
          },
        ],
      });
      const rejectFirstBinding = yield* Ref.make(true);
      const payload = yield* encodeJournal({ workspace, backups: [] });
      yield* sql`INSERT INTO workspace_restores (thread_id, stage, payload_json) VALUES (${thread.id}, 'recovery-required', ${payload})`;
      const dependencies = Layer.mergeAll(
        Layer.mock(WorkspaceRepositoryResolver.WorkspaceRepositoryResolver)({
          verify: () => Effect.void,
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ detach: () => Effect.void }),
        Layer.mock(TerminalManager.TerminalManager)({
          subscribeMetadata: (listener) =>
            listener({ type: "snapshot", terminals: [] }).pipe(Effect.as(() => {})),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords: () => Ref.get(projection),
          dispatch: (command) =>
            Effect.gen(function* () {
              if (command.type === "provider-session.detach") {
                yield* Ref.update(projection, (current) => ({
                  ...current,
                  providerSessions: current.providerSessions.filter(
                    (session) => session.id !== command.providerSessionId,
                  ),
                }));
                return { sequence: 1, storedEvents: [] };
              }
              if (command.type !== "thread.workspace.bind")
                return yield* Effect.die("unexpected command");
              if (yield* Ref.getAndSet(rejectFirstBinding, false))
                return yield* new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "interrupted before commit",
                });
              const current = yield* Ref.get(projection);
              const planned = planWorkspaceBinding({
                command,
                projection: current,
                now: current.thread.updatedAt,
              });
              assert.isTrue(Result.isSuccess(planned));
              yield* Ref.set(projection, { ...current, thread: Result.getOrThrow(planned) });
              return { sequence: 1, storedEvents: [] };
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const recovery = yield* WorkspaceRecovery.WorkspaceRecovery;
        const target = { threadId: thread.id, expectedRevisionId: workspace.id };
        assert.equal((yield* recovery.resolve({ ...target, action: "inspect" })).kind, "restore");
        yield* recovery.resolve({ ...target, action: "accept-current-files" }).pipe(Effect.flip);
        const [beforeRetry] = yield* sql<{
          stage: string;
          payload_json: string;
        }>`SELECT stage, payload_json FROM workspace_restores`;
        assert.equal(beforeRetry!.stage, "recovering-binding");
        const recorded = yield* decodeJournal(beforeRetry!.payload_json);
        assert.equal((yield* Ref.get(projection)).thread.workspace?.id, workspace.id);
        assert.equal(
          (yield* recovery.resolve({ ...target, action: "accept-current-files" })).kind,
          "ready",
        );
        const rebound = (yield* Ref.get(projection)).thread;
        assert.equal(rebound.workspace?.id, recorded.recoveryWorkspace?.id);
        assert.equal(rebound.workspace?.previousRevisionId, workspace.id);
        assert.deepEqual(rebound.workspace?.resources, workspace.resources);
        assert.isNull(rebound.activeProviderThreadId);
        assert.include(
          (yield* recovery.resolve({ ...target, action: "inspect" }).pipe(Effect.flip)).message,
          "changed",
        );
      }).pipe(Effect.provide(WorkspaceRecovery.layer.pipe(Layer.provide(dependencies))));
    }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer)))),
);

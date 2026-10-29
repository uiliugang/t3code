import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Ref from "effect/Ref";
import type { TerminalSummary } from "@t3tools/contracts";
import {
  CommandId,
  ThreadWorkspaceRevision,
  WorkspaceRecoveryError,
  WorkspaceRevisionId,
  type WorkspaceRecoveryInput,
  type WorkspaceRecoveryResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { Preparation } from "./WorkspaceProvisioner.ts";
import { RestoreJournal } from "./WorkspaceRestore.ts";
import * as WorkspaceRepositoryResolver from "./WorkspaceRepositoryResolver.ts";
import { withWorkspaceLease, withWorkspaceLeases } from "./workspaceLease.ts";

const preparationJson = Schema.fromJsonString(Preparation);
const restoreJson = Schema.fromJsonString(RestoreJournal);

export class WorkspaceRecovery extends Context.Service<
  WorkspaceRecovery,
  {
    readonly resolve: (
      input: WorkspaceRecoveryInput,
    ) => Effect.Effect<WorkspaceRecoveryResult, WorkspaceRecoveryError>;
  }
>()("t3/workspace/WorkspaceRecovery") {}

const isWorkspaceRecoveryError = Schema.is(WorkspaceRecoveryError);

export const layer = Layer.effect(
  WorkspaceRecovery,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const terminals = yield* TerminalManager.TerminalManager;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const resolver = yield* WorkspaceRepositoryResolver.WorkspaceRepositoryResolver;
    const crypto = yield* Crypto.Crypto;
    return WorkspaceRecovery.of({
      resolve: Effect.fn("WorkspaceRecovery.resolve")(
        function* (input) {
          return yield* withWorkspaceLease(
            `prepare:${input.threadId}`,
            Effect.gen(function* () {
              const projection = yield* threads.getThreadRecords(input.threadId, [
                "runs",
                "providerSessions",
                "runtimeRequests",
              ]);
              const workspace = projection.thread.workspace;
              if ((workspace?.id ?? null) !== input.expectedRevisionId)
                return yield* new WorkspaceRecoveryError({
                  detail: "The task group changed. Reopen recovery.",
                });
              const assertIdle = () =>
                projection.thread.deletedAt !== null ||
                projection.thread.archivedAt !== null ||
                projection.runs.some((run) =>
                  ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
                ) ||
                projection.runtimeRequests.some((request) => request.status === "pending");
              if (input.action !== "inspect" && assertIdle())
                return yield* new WorkspaceRecoveryError({
                  detail: "Stop the task and cancel queued messages before recovering its group.",
                });
              if (input.action !== "inspect") {
                const terminalState = yield* Ref.make<ReadonlyArray<TerminalSummary>>([]);
                const openTerminals = yield* Effect.acquireUseRelease(
                  terminals.subscribeMetadata((event) =>
                    event.type === "snapshot"
                      ? Ref.set(terminalState, event.terminals)
                      : Effect.void,
                  ),
                  () => Ref.get(terminalState),
                  (stop) => Effect.sync(stop),
                );
                if (
                  openTerminals.some(
                    (terminal) =>
                      (terminal.threadId === input.threadId ||
                        workspace?.resources.some(
                          (resource) =>
                            workspaceRelativeFilePath(terminal.cwd, resource.checkoutRoot) !== null,
                        )) &&
                      ["starting", "running"].includes(terminal.status),
                  )
                )
                  return yield* new WorkspaceRecoveryError({
                    detail: "Close this group's terminals before confirming recovery.",
                  });
              }
              const restoreRows = yield* sql<{
                stage: string;
                payload_json: string;
              }>`SELECT stage, payload_json FROM workspace_restores WHERE thread_id = ${input.threadId} AND stage != 'complete'`;
              if (restoreRows[0] && workspace) {
                let journal = yield* Schema.decodeEffect(restoreJson)(restoreRows[0].payload_json);
                const report = {
                  kind: "restore" as const,
                  detail:
                    "Inspect every repository before continuing. Accepting keeps the current files and starts a new provider conversation; backups and the old history remain available.",
                  repositories: workspace.resources.map((resource) => ({
                    name: resource.name,
                    path: resource.checkoutRoot,
                    stage: restoreRows[0]!.stage,
                  })),
                };
                if (input.action === "inspect") return report;
                if (input.action !== "accept-current-files")
                  return yield* new WorkspaceRecoveryError({
                    detail: "This task needs restore recovery.",
                  });
                return yield* withWorkspaceLeases(
                  workspace.resources.map((resource) => `resource:${resource.id}`),
                  Effect.gen(function* () {
                    for (const resource of workspace.resources)
                      yield* resolver.verify(resource.identity);
                    const revision =
                      journal.recoveryWorkspace ??
                      ThreadWorkspaceRevision.make({
                        ...workspace,
                        id: WorkspaceRevisionId.make(
                          yield* crypto.randomUUIDv4().pipe(Effect.orDie),
                        ),
                        previousRevisionId: workspace.id,
                        createdAt: DateTime.formatIso(yield* DateTime.now),
                      });
                    if (journal.recoveryWorkspace === undefined) {
                      journal = { ...journal, recoveryWorkspace: revision };
                      const payload = yield* Schema.encodeEffect(restoreJson)(journal);
                      yield* sql`UPDATE workspace_restores SET payload_json = ${payload}, stage = 'recovering-binding' WHERE thread_id = ${input.threadId}`;
                    }
                    for (const session of projection.providerSessions) {
                      yield* sessions.detach({
                        providerSessionId: session.id,
                        threadId: input.threadId,
                        revokeMcpCredential: true,
                      });
                      yield* threads.dispatch({
                        type: "provider-session.detach",
                        commandId: CommandId.make(
                          `workspace-recovery:${revision.id}:detach:${session.id}`,
                        ),
                        threadId: input.threadId,
                        providerSessionId: session.id,
                        reason: "Group recovery",
                      });
                    }
                    if (workspace.id !== revision.id)
                      yield* threads.dispatch({
                        type: "thread.workspace.bind",
                        commandId: CommandId.make(`workspace-recovery:${revision.id}`),
                        threadId: input.threadId,
                        expectedWorkspaceRevisionId: revision.previousRevisionId,
                        workspace: revision,
                      });
                    yield* sql`UPDATE workspace_restores SET stage = 'complete' WHERE thread_id = ${input.threadId}`;
                    return {
                      ...report,
                      kind: "ready" as const,
                      detail:
                        "Current files accepted. The next message starts a new provider conversation. Describe the work to continue.",
                    };
                  }),
                );
              }
              const rows = yield* sql<{
                payload_json: string;
              }>`SELECT payload_json FROM workspace_preparations WHERE thread_id = ${input.threadId}`;
              if (workspace === undefined && rows[0]) {
                const preparation = yield* Schema.decodeEffect(preparationJson)(
                  rows[0].payload_json,
                );
                const report = {
                  kind: "preparation" as const,
                  detail:
                    "Prepared repositories are retained. Confirm only after inspecting the setup terminals; retry may repeat setup commands. Then retry the task's preparation.",
                  repositories: preparation.resources.map((resource) => ({
                    name: resource.source.name,
                    path: resource.path,
                    stage: resource.setup,
                  })),
                };
                if (input.action === "inspect") return report;
                if (input.action !== "retry-setup")
                  return yield* new WorkspaceRecoveryError({
                    detail: "This task needs setup recovery.",
                  });
                const payload = yield* Schema.encodeEffect(preparationJson)({
                  ...preparation,
                  resources: preparation.resources.map((resource) =>
                    resource.setup === "running"
                      ? { ...resource, setup: "failed" as const }
                      : resource,
                  ),
                });
                yield* sql`UPDATE workspace_preparations SET payload_json = ${payload} WHERE thread_id = ${input.threadId}`;
                return {
                  ...report,
                  kind: "ready" as const,
                  detail: "Setup can now be retried from the task's retry action.",
                };
              }
              return {
                kind: "ready" as const,
                detail: "This task has no unfinished group recovery.",
                repositories: [],
              };
            }),
          );
        },
        (effect) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isWorkspaceRecoveryError(cause)
                ? cause
                : new WorkspaceRecoveryError({
                    detail:
                      "Group recovery did not finish. Its journal and backups have been retained.",
                    cause,
                  }),
            ),
          ),
      ),
    });
  }),
);

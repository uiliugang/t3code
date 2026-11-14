import {
  CommandId,
  DeliveryScope,
  WorkItem,
  WorkItemCommandInput,
  WorkItemError,
  WorkItemDelivery,
  WorkItemId,
  type WorkItemMutationResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Issues from "../sourceControl/IssueService.ts";
import * as WorkItems from "./WorkItemService.ts";
import * as Mcm from "./McmReleaseService.ts";
import { decideDelivery } from "./deliveryDecision.ts";

export class DeliverySyncReactor extends Context.Service<
  DeliverySyncReactor,
  {
    readonly drain: () => Effect.Effect<void>;
    readonly refresh: (id: WorkItemId) => Effect.Effect<WorkItemMutationResult, WorkItemError>;
  }
>()("t3/work-items/DeliverySyncReactor") {}

const encodeCommand = Schema.encodeSync(Schema.fromJsonString(WorkItemCommandInput));
const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkItemCommandInput));
const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkItem));
const encodeScope = Schema.encodeEffect(Schema.fromJsonString(DeliveryScope));
const isWorkItemError = Schema.is(WorkItemError);
const sameDelivery = Schema.toEquivalence(WorkItemDelivery);

export const layer = Layer.effect(
  DeliverySyncReactor,
  Effect.gen(function* () {
    const items = yield* WorkItems.WorkItemService;
    const threads = yield* Threads.ThreadManagementService;
    const issues = yield* Issues.IssueService;
    const mcm = yield* Mcm.McmReleaseService;
    const sql = yield* SqlClient.SqlClient;
    const serial = yield* Semaphore.make(1);

    const refresh = Effect.fn("DeliverySyncReactor.refresh")(function* (initial: WorkItem) {
      let item = initial;
      if (item.delivery === undefined || item.archived) return;
      let delivery: WorkItemDelivery = item.delivery;
      const scope = delivery.scope;
      if (scope.confirmedRevision !== scope.revision && !delivery.reopenRequest) return;
      const target = {
        projectId: item.projectId,
        provider: delivery.issue.provider,
        scope: delivery.issue.repository,
        id: delivery.issue.id,
      };
      const detail = yield* issues.read(target);
      if (delivery.reopenRequest) {
        if (delivery.reopenRequest.scopeRevision !== scope.revision) return;
        const current = yield* items.get(item.id);
        if (current.version !== item.version) return;
        if (detail.stateCategory === "done")
          yield* issues.setState({ ...target, state: delivery.reopenRequest.state });
        const verified = yield* issues.read(target);
        if (verified.stateCategory === "done")
          return yield* new WorkItemError({
            code: "execution",
            message: "The issue could not be reopened.",
          });
        yield* items.recordDelivery(item.id, item.version, {
          ...delivery,
          reopenRequest: undefined,
          syncedRevision: undefined,
          externalState: verified.state,
          syncError: null,
          scope: { ...scope, confirmedRevision: null },
          evidence: { ...delivery.evidence, anomaly: null },
        });
        return;
      }
      const pullRequests = yield* Effect.forEach(item.sources, (source) =>
        threads.getThreadShell(source.threadId),
      );
      const links = pullRequests.flatMap((thread) => thread?.pullRequests ?? []);
      const releases = yield* Effect.forEach(
        delivery.evidence.planIds,
        (planId) => mcm.read(planId, scope.changedServices),
        { concurrency: 2 },
      );
      const hadCompleteRelease = delivery.evidence.releases.length > 0;
      const evidence = {
        ...delivery.evidence,
        pullRequests: scope.requiredPullRequests.map((url) => ({
          url,
          merged: links.some((link) => link.url === url && link.snapshot?.state === "merged"),
        })),
        releases: releases.flat(),
      };
      if (
        delivery.syncedRevision !== undefined &&
        hadCompleteRelease &&
        evidence.releases.length < delivery.evidence.releases.length
      )
        evidence.anomaly =
          "A previously completed deployment no longer covers this delivery. Confirm whether to reopen the issue.";
      if (delivery.syncedRevision !== undefined && detail.stateCategory !== "done")
        evidence.anomaly =
          "The external issue was reopened. Confirm before resuming automatic completion.";
      const decision = decideDelivery(delivery.issue.provider, scope, evidence);
      const completedTransitions = detail.transitions.filter(
        (transition) => transition.category === "DONE",
      );
      const state =
        delivery.issue.provider === "github"
          ? "completed"
          : (delivery.completionState ??
            (completedTransitions.length === 1 ? completedTransitions[0]?.value : undefined));
      const missingCompletionState =
        decision.nextAction === "complete_external" &&
        detail.stateCategory !== "done" &&
        (state === undefined ||
          (delivery.issue.provider === "meituan" &&
            !completedTransitions.some((transition) => transition.value === state)));
      const updated = {
        ...delivery,
        evidence,
        externalState: detail.state,
        syncError: missingCompletionState
          ? "Choose the completed state for this ONES workflow."
          : decision.nextAction !== "none" && delivery.syncedRevision === undefined
            ? (delivery.syncError ?? null)
            : null,
      };
      if (!sameDelivery(updated, delivery)) {
        delivery = { ...updated, lastSyncedAt: DateTime.formatIso(yield* DateTime.now) };
        item = yield* items.recordDelivery(item.id, item.version, delivery);
      }
      if (decision.nextAction === "create_mcm") {
        const source = pullRequests.find((thread) => thread !== null);
        if (source === undefined)
          return yield* new WorkItemError({
            code: "invalid_state",
            message: "A source conversation is required to create the MCM plan.",
          });
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM work_item_delivery_actions WHERE work_item_id = ${item.id} AND scope_revision = ${scope.revision} AND kind = 'create_mcm'`;
        if (rows[0] === undefined) {
          const scopeJson = yield* encodeScope(scope);
          const input: WorkItemCommandInput = {
            type: "start",
            commandId: CommandId.make(`delivery:mcm:${item.id}:${scope.revision}`),
            id: item.id,
            specRevision: item.specRevision,
            deliveryRevision: scope.revision,
            participants: [
              {
                modelSelection: source.modelSelection,
                runtimeMode: source.runtimeMode,
                interactionMode: "default",
                workspaceStrategy: { type: "root" },
                assignment: `Use the mcm-cli skill to find or create draft MCM plans for ${delivery.issue.url}. Delivery scope: ${scopeJson}. All necessary PRs have merged. Only create plans; do not submit, approve or execute them. First check existing plans covering these exact PRs and services. Reuse matching plans. If a creation result is uncertain, investigate before retrying. Ask the user for missing information. Report plan IDs using work_item_report_release for work item ${item.id}, reading its latest version first. Do not edit code or expand the delivery scope.`,
              },
            ],
          };
          yield* sql`INSERT OR IGNORE INTO work_item_delivery_actions (work_item_id, scope_revision, kind, payload_json) VALUES (${item.id}, ${scope.revision}, 'create_mcm', ${encodeCommand(input)})`;
        }
        const saved = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM work_item_delivery_actions WHERE work_item_id = ${item.id} AND scope_revision = ${scope.revision} AND kind = 'create_mcm'`;
        if (saved[0]) {
          yield* items.mutate(yield* decodeCommand(saved[0].payload_json));
          const current = yield* items.get(item.id);
          if (current.delivery?.scope.revision === scope.revision && current.delivery.syncError)
            yield* items.recordDelivery(item.id, current.version, {
              ...current.delivery,
              syncError: null,
            });
        }
      }
      if (decision.nextAction === "complete_external" && delivery.syncedRevision === undefined) {
        if (detail.stateCategory === "done") {
          yield* items.recordDelivery(item.id, item.version, {
            ...delivery,
            syncedRevision: scope.revision,
            syncError: null,
          });
          return;
        }
        if (
          state === undefined ||
          (delivery.issue.provider === "meituan" &&
            !completedTransitions.some((transition) => transition.value === state))
        ) {
          return;
        }
        const current = yield* items.get(item.id);
        if (
          current.version !== item.version ||
          current.delivery?.scope.confirmedRevision !== scope.revision
        )
          return;
        yield* issues.setState({ ...target, state });
        const verified = yield* issues.read(target);
        if (verified.stateCategory !== "done")
          return yield* new WorkItemError({
            code: "execution",
            message: "The external issue completion could not be confirmed.",
          });
        yield* items.recordDelivery(item.id, item.version, {
          ...delivery,
          syncedRevision: scope.revision,
          externalState: verified.state,
          syncError: null,
        });
      }
    });

    const drain = Effect.fn("DeliverySyncReactor.drain")(function* () {
      yield* serial
        .withPermits(1)(
          Effect.gen(function* () {
            const rows = yield* sql<{
              item_json: string;
            }>`SELECT item_json FROM work_items WHERE json_extract(item_json, '$.delivery') IS NOT NULL AND json_extract(item_json, '$.archived') = 0`;
            yield* Effect.forEach(
              rows,
              (row) =>
                Effect.gen(function* () {
                  const item = yield* decodeItem(row.item_json);
                  yield* refresh(item).pipe(
                    Effect.catch((cause) =>
                      Effect.gen(function* () {
                        yield* Effect.logWarning("delivery.sync-failed", { id: item.id, cause });
                        const current = yield* items.get(WorkItemId.make(item.id));
                        if (
                          current.delivery !== undefined &&
                          current.delivery.syncError !==
                            "Could not synchronize delivery. Check access to PRs, MCM and the issue platform."
                        )
                          yield* items.recordDelivery(current.id, current.version, {
                            ...current.delivery,
                            syncError:
                              "Could not synchronize delivery. Check access to PRs, MCM and the issue platform.",
                          });
                      }),
                    ),
                  );
                }).pipe(Effect.ignoreCause({ log: true })),
              { concurrency: 2 },
            );
          }),
        )
        .pipe(Effect.ignoreCause({ log: true }));
    });
    const refreshDelivery = Effect.fn("DeliverySyncReactor.refreshDelivery")(
      function* (id: WorkItemId) {
        yield* serial.withPermits(1)(
          Effect.gen(function* () {
            yield* refresh(yield* items.get(id));
          }),
        );
        return { item: yield* items.get(id) };
      },
      Effect.mapError((cause) =>
        isWorkItemError(cause)
          ? cause
          : new WorkItemError({
              code: "execution",
              message: "Could not refresh delivery progress.",
              cause,
            }),
      ),
    );
    yield* drain().pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);
    return { drain, refresh: refreshDelivery };
  }),
);

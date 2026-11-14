import { OrchestratorMcpFailure, type WorkItemCommandInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as WorkItems from "../../../work-items/WorkItemService.ts";
import { executionIsActive } from "../../../work-items/decide.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertTargetWithinLimits, readCaller, unavailable } from "../../threadAccess.ts";
import { WorkItemToolkit } from "./tools.ts";

const mutate = Effect.fn("WorkItemMcp.mutate")(function* (input: WorkItemCommandInput) {
  const context = yield* readCaller();
  const service = yield* WorkItems.WorkItemService;
  if (input.type === "start") {
    for (const participant of input.participants)
      yield* assertTargetWithinLimits(context.limits, participant);
  }
  if (input.type === "stop") {
    const item = yield* service.get(input.id).pipe(Effect.mapError(unavailable));
    for (const execution of item.executions.filter(executionIsActive)) {
      if (input.executionId !== undefined && execution.id !== input.executionId) continue;
      const target = yield* context.threads
        .getThreadShell(execution.threadId)
        .pipe(Effect.mapError(unavailable));
      yield* assertTargetWithinLimits(context.limits, target ?? execution);
    }
  }
  if (context.caller !== undefined) {
    const target =
      input.type === "create"
        ? undefined
        : yield* service.get(input.id).pipe(Effect.mapError(unavailable));
    const projectId = input.type === "create" ? input.projectId : target?.projectId;
    if (
      projectId !== context.caller.projectId &&
      !target?.sources.some((source) => source.threadId === context.scope.thread?.threadId)
    )
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "This task must belong to the calling thread's project.",
      });
  }
  return yield* service
    .mutate(input, context.scope.thread?.threadId, context.limits)
    .pipe(
      Effect.mapError((error) =>
        error.code === "persistence" || error.code === "execution"
          ? unavailable()
          : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
      ),
    );
});

export const layer = McpToolAccess.toLayer(WorkItemToolkit, {
  work_item_link_issue: McpToolAccess.writes((input) => mutate({ ...input, type: "link_issue" })),
  work_item_associate_issue: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const threadId = context.scope.thread?.threadId ?? input.threadId;
      if (
        threadId === undefined ||
        (context.scope.thread !== undefined &&
          input.threadId !== undefined &&
          input.threadId !== threadId)
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Associate the calling conversation only.",
        });
      const thread = yield* context.threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(unavailable));
      if (thread === null)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Conversation unavailable.",
        });
      const service = yield* WorkItems.WorkItemService;
      return yield* service
        .associateIssue({
          projectId: thread.projectId,
          threadId,
          issue: input.issue,
          title: input.title,
        })
        .pipe(Effect.mapError(unavailable));
    }),
  ),
  work_item_update_delivery_scope: McpToolAccess.writes((input) =>
    mutate({ ...input, type: "delivery_scope" }),
  ),
  work_item_confirm_delivery_scope: McpToolAccess.writes((input) =>
    mutate({ ...input, type: "confirm_scope" }),
  ),
  work_item_report_release: McpToolAccess.writes((input) =>
    mutate({ ...input, type: "release_plans" }),
  ),
  work_item_report_delivery_exception: McpToolAccess.writes((input) =>
    mutate({ ...input, type: "delivery_exception" }),
  ),
  work_item_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const service = yield* WorkItems.WorkItemService;
      return yield* service
        .list({ ...input, projectId: input.projectId ?? context.caller?.projectId })
        .pipe(Effect.mapError(unavailable));
    }),
  ),
  work_item_get: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const service = yield* WorkItems.WorkItemService;
      const item = yield* service.get(input.id).pipe(Effect.mapError(unavailable));
      const projectId = input.projectId ?? context.caller?.projectId;
      if (
        projectId !== undefined &&
        item.projectId !== projectId &&
        !item.sources.some((source) => source.threadId === context.scope.thread?.threadId)
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The task does not belong to this project.",
        });
      return item;
    }),
  ),
  work_item_create: McpToolAccess.writes((input) => mutate({ ...input, type: "create" })),
  work_item_update: McpToolAccess.writes((input) => mutate({ ...input, type: "update" })),
  work_item_start: McpToolAccess.writes((input) => mutate({ ...input, type: "start" })),
  work_item_stop: McpToolAccess.writes((input) => mutate({ ...input, type: "stop" })),
  work_item_report: McpToolAccess.actsAsCaller((input) => mutate({ ...input, type: "report" })),
  work_item_submit: McpToolAccess.actsAsCaller((input) =>
    mutate({ ...input, type: "report", submitted: true }),
  ),
});

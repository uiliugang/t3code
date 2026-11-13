import {
  OrchestratorMcpFailure,
  WorkItem,
  WorkItemCommandInput,
  WorkItemListInput,
  WorkItemListResult,
  WorkItemMutationResult,
  BranchIssueRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { Tool, Toolkit } from "effect/ai";
import * as WorkItems from "../../../work-items/WorkItemService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const dependencies = [
  Invocation.McpInvocationContext,
  Threads.ThreadManagementService,
  WorkItems.WorkItemService,
];
const shared = { dependencies, failure: OrchestratorMcpFailure, failureMode: "return" as const };
const [create, update, start, stop, report] = WorkItemCommandInput.members;

export const WorkItemToolkit = Toolkit.make(
  Tool.make("work_item_link_issue", {
    ...shared,
    description:
      "Attach a created external issue to this existing local work item. Use the canonical platform URL and current expectedVersion. Preserve its source conversations; do not create a duplicate task.",
    parameters: WorkItemCommandInput.members[10].mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_associate_issue", {
    ...shared,
    description:
      "Associate the current conversation with its delivery issue. References are not automatically delivery goals. Reuse the existing issue record across conversations. Never create duplicate task cards for the same issue.",
    parameters: Schema.Struct({
      issue: BranchIssueRef,
      threadId: Schema.optional(ThreadId),
      title: WorkItem.fields.title,
    }),
    success: WorkItem,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_update_delivery_scope", {
    ...shared,
    description:
      "Record every necessary PR and changed service/deployment target for this issue. revision for a service is the exact delivery PR URL exposed by MCM. Updating invalidates scope confirmation. Exclude replaced PRs explicitly. Ask the user if ownership or coverage is uncertain.",
    parameters: WorkItemCommandInput.members[11].mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_confirm_delivery_scope", {
    ...shared,
    description:
      "Confirm only the current complete delivery scope after identifying ALL necessary PRs and changed services. Do not confirm partial or uncertain scope. T3 then tracks PRs, creates MCM plans after all required PRs merge, and closes the external issue only when its platform-specific delivery condition is met.",
    parameters: WorkItemCommandInput.members[12].mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_report_release", {
    ...shared,
    description:
      "Associate MCM plan identifiers with this delivery. T3 verifies service, environment and delivery PR against MCM; this report cannot declare a deployment successful. Reuse existing plans, never create duplicates after an uncertain response. Creation does not authorize submission, approval or execution.",
    parameters: WorkItemCommandInput.members[13].mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_report_delivery_exception", {
    ...shared,
    description:
      "Report verified rollback, deployment reversal or missing necessary delivery. T3 flags the exception for the user. Never reopen the external issue without the user's confirmation.",
    parameters: WorkItemCommandInput.members[14].mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_list", {
    ...shared,
    description:
      "List project task cards and their independent agent executions. Omit projectId for the calling thread's project.",
    parameters: WorkItemListInput,
    success: WorkItemListResult,
  }).annotate(Tool.Readonly, true),
  Tool.make("work_item_get", {
    ...shared,
    description:
      "Read a task, its current specification revision, acceptance criteria, sources, and each agent's result.",
    parameters: Schema.Struct({
      id: WorkItem.fields.id,
      projectId: Schema.optional(WorkItem.fields.projectId),
    }),
    success: WorkItem,
  }).annotate(Tool.Readonly, true),
  Tool.make("work_item_create", {
    ...shared,
    description:
      "Create a project task with the user's goal, constraints and acceptance criteria. Does not start an agent. Reuse commandId after a lost reply.",
    parameters: create.mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_update", {
    ...shared,
    description:
      "Edit a task using its expectedVersion. Changes apply to future executions; running agents retain their specification snapshot. Do not expand the user's scope.",
    parameters: update.mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_start", {
    ...shared,
    description:
      "Dispatch explicitly requested participants to one task. Different providers or models may work concurrently, each in its own thread and checkout. Preserve the specification revision and reuse commandId when retrying the same dispatch.",
    parameters: start.mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  })
    .annotate(Tool.Destructive, true)
    .annotate(Tool.OpenWorld, true),
  Tool.make("work_item_stop", {
    ...shared,
    description:
      "Stop one execution by executionId, or all executions of this task when omitted. Other tasks are unaffected; stopping one participant leaves its peers running.",
    parameters: stop.mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_report", {
    ...shared,
    description:
      "Report progress or a deliverable only for your own execution thread and its specification revision. Preserve evidence and unresolved issues. Reporting does not accept the task.",
    parameters: report.mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, false),
  Tool.make("work_item_submit", {
    ...shared,
    description:
      "Submit your execution's result for selection and user review. Other participants may continue. A finished run, plan, or self-reported test pass never means the user has accepted the task.",
    parameters: report.mapFields(Struct.omit(["type", "submitted"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, false),
);

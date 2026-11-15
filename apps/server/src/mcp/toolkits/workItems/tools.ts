import {
  OrchestratorMcpFailure,
  WorkItem,
  WorkItemCommandInput,
  WorkItemListInput,
  WorkItemListResult,
  WorkItemMutationResult,
  BranchIssueRef,
  ThreadId,
  WorkItemParticipant,
  WorkItemIssueInput,
  WorkItemIssueResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { Tool, Toolkit } from "effect/ai";
import * as WorkItems from "../../../work-items/WorkItemService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as DeliveryAutomation from "../../../work-items/DeliveryAutomationService.ts";

const dependencies = [
  Invocation.McpInvocationContext,
  Threads.ThreadManagementService,
  WorkItems.WorkItemService,
];
const shared = { dependencies, failure: OrchestratorMcpFailure, failureMode: "return" as const };
const [create, update, start, stop, report] = WorkItemCommandInput.members;

export const WorkItemToolkit = Toolkit.make(
  Tool.make("work_item_issue", {
    ...shared,
    dependencies: [...dependencies, DeliveryAutomation.DeliveryAutomationService],
    description:
      "Issue side chats only: metadata reads fields; create links its result; recover links an uncertain URL. Never blindly retry; code stays read-only.",
    parameters: WorkItemIssueInput,
    success: WorkItemIssueResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_link_issue", {
    ...shared,
    description:
      "Link an existing issue using its canonical URL and current expectedVersion. Keep source conversations; never duplicate the task.",
    parameters: WorkItemCommandInput.members[10].mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_associate_issue", {
    ...shared,
    description:
      "Associate only the calling conversation's delivery goal, not references. Reuse its issue record across conversations; never duplicate issue cards.",
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
      "Record ALL required PRs and changed services/targets. A service revision is its delivery PR URL from MCM. Updates invalidate confirmation. Explicitly exclude replaced PRs; ask about uncertain ownership or coverage.",
    parameters: WorkItemCommandInput.members[11].mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_confirm_delivery_scope", {
    ...shared,
    description:
      "Confirm only the complete, current scope with ALL required PRs and services; ask about uncertainty. T3 tracks merges, prepares MCM plans after all PRs merge, and closes the issue only after its platform's delivery condition.",
    parameters: WorkItemCommandInput.members[12].mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_report_release", {
    ...shared,
    description:
      "Link MCM plan IDs. T3 verifies service, environment and delivery PR; reporting never proves deployment success. Reuse plans after uncertain replies. Creating a plan does not authorize submission, approval or execution.",
    parameters: WorkItemCommandInput.members[13].mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_report_delivery_exception", {
    ...shared,
    description:
      "Report verified rollback, reversal or missing delivery for the user. Reopening an issue requires user confirmation.",
    parameters: WorkItemCommandInput.members[14].mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_list", {
    ...shared,
    description:
      "List project tasks and agent executions; projectId defaults to the caller's project.",
    parameters: WorkItemListInput.mapFields(Struct.omit(["issueUrls"])),
    success: WorkItemListResult,
  }).annotate(Tool.Readonly, true),
  Tool.make("work_item_get", {
    ...shared,
    description: "Read a task's revision, criteria, sources and agent results.",
    parameters: Schema.Struct({
      id: WorkItem.fields.id,
      projectId: Schema.optional(WorkItem.fields.projectId),
    }),
    success: WorkItem,
  }).annotate(Tool.Readonly, true),
  Tool.make("work_item_create", {
    ...shared,
    description:
      "Create a project task with the user's goal, constraints and criteria, without starting an agent. Reuse commandId after a lost reply.",
    parameters: create.mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_update", {
    ...shared,
    description:
      "Use expectedVersion to edit future executions; running agents retain their snapshot. Preserve user scope.",
    parameters: update.mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_start", {
    ...shared,
    description:
      "Start only requested participants with the current specRevision. Each gets its own thread/checkout; providers/models may run concurrently. Retry with the same commandId.",
    parameters: start.mapFields(({ type: _type, participants: _participants, ...fields }) => ({
      ...fields,
      participants: Schema.Array(WorkItemParticipant.mapFields(Struct.omit(["sideChatOf"]))).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(20),
      ),
    })),
    success: WorkItemMutationResult,
  })
    .annotate(Tool.Destructive, true)
    .annotate(Tool.OpenWorld, true),
  Tool.make("work_item_stop", {
    ...shared,
    description:
      "Stop executionId, or all this task's executions if omitted. Leave other tasks and unselected peers running.",
    parameters: stop.mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("work_item_report", {
    ...shared,
    description:
      "Report progress, evidence and unresolved issues for your own execution and specRevision. Reporting does not accept the task.",
    parameters: report.mapFields(Struct.omit(["type"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, false),
  Tool.make("work_item_submit", {
    ...shared,
    description:
      "Submit your execution for user selection/review while peers continue. Finished runs, plans and claimed tests do not mean user acceptance.",
    parameters: report.mapFields(Struct.omit(["type", "submitted"])),
    success: WorkItemMutationResult,
  }).annotate(Tool.Destructive, false),
);

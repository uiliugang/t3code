import {
  CommandId,
  WorkItem,
  WorkItemCommandInput,
  IssueSource,
  type WorkItemCreateIssueInput,
  WorkItemError,
  type WorkItemMutationResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Issues from "../sourceControl/IssueService.ts";
import * as WorkItems from "./WorkItemService.ts";

const decodeItemJson = Schema.decodeEffect(Schema.fromJsonString(WorkItem));
const encodeSourceJson = Schema.encodeEffect(Schema.fromJsonString(IssueSource));
const encodeCommandJson = Schema.encodeEffect(Schema.fromJsonString(WorkItemCommandInput));
const decodeCommandJson = Schema.decodeEffect(Schema.fromJsonString(WorkItemCommandInput));
const isWorkItemError = Schema.is(WorkItemError);

export class DeliveryAutomationService extends Context.Service<
  DeliveryAutomationService,
  {
    readonly createIssue: (
      input: WorkItemCreateIssueInput,
    ) => Effect.Effect<WorkItemMutationResult, WorkItemError>;
  }
>()("t3/work-items/DeliveryAutomationService") {}

export const layer = Layer.effect(
  DeliveryAutomationService,
  Effect.gen(function* () {
    const items = yield* WorkItems.WorkItemService;
    const threads = yield* Threads.ThreadManagementService;
    const issues = yield* Issues.IssueService;
    const sql = yield* SqlClient.SqlClient;
    const createIssue = Effect.fn("DeliveryAutomationService.createIssue")(
      function* (input: WorkItemCreateIssueInput) {
        const thread = yield* threads.getThreadShell(input.threadId);
        if (thread === null)
          return yield* new WorkItemError({
            code: "not_found",
            message: "Conversation unavailable.",
          });
        const configured = yield* issues.sources({ projectIds: [thread.projectId] });
        if (
          !configured[0]?.sources.some(
            (source) =>
              source.provider === input.source.provider &&
              source.scope === input.source.scope &&
              source.host === input.source.host,
          )
        )
          return yield* new WorkItemError({
            code: "invalid_request",
            message: "Choose an issue source configured for this project.",
          });
        const creationKey = `delivery:issue:${input.threadId}:${input.source.provider}:${input.source.host}:${input.source.scope}`;
        const createId = CommandId.make(`${creationKey}:create`);
        const saved = yield* sql<{
          result_json: string;
        }>`SELECT result_json FROM work_item_commands WHERE command_id = ${createId}`;
        let item: WorkItem;
        if (saved[0]) {
          item = yield* decodeItemJson(saved[0].result_json);
          if (item.sources[0]?.threadId !== input.threadId)
            return yield* new WorkItemError({
              code: "conflict",
              message: "This creation identifier belongs to another conversation.",
            });
        } else {
          const records = yield* threads.getThreadRecords(input.threadId, ["messages"]);
          const context = records.messages
            .filter((message) => !message.streaming)
            .map((message) => `${message.role}: ${message.text}`)
            .join("\n\n")
            .slice(-16000);
          item = (yield* items.mutate({
            type: "create",
            commandId: createId,
            projectId: thread.projectId,
            title: thread.title.slice(0, 300) || "Create issue",
            description: context,
            constraints: [],
            acceptanceCriteria: [],
            priority: "P2",
            sources: [{ threadId: thread.id, title: thread.title.slice(0, 300) }],
          })).item;
        }
        const sourceJson = yield* encodeSourceJson(input.source);
        const start: WorkItemCommandInput = {
          type: "start",
          commandId: CommandId.make(`${creationKey}:start`),
          id: item.id,
          specRevision: item.specRevision,
          participants: [
            {
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              assignment: `The user clicked Create issue for the source conversation ${input.threadId}. Create one external issue using ONLY this configured destination: ${sourceJson}. Use the source conversation snapshot in the goal to prepare title, description and acceptance criteria. Ask only for missing required fields. Reuse an existing issue if a previous creation may have succeeded; never blindly retry an uncertain external write. Use the platform's existing CLI/skill. After creation, call work_item_link_issue for work item ${item.id} with its canonical issue identity, reading latest version first. This work item already links the user's original conversation; do not create a second task. Do not modify code or start development.`,
            },
          ],
        };
        yield* sql`INSERT OR IGNORE INTO work_item_delivery_actions (work_item_id, scope_revision, kind, payload_json) VALUES (${item.id}, 0, 'create_issue', ${yield* encodeCommandJson(start)})`;
        const action = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM work_item_delivery_actions WHERE work_item_id = ${item.id} AND scope_revision = 0 AND kind = 'create_issue'`;
        if (!action[0])
          return yield* new WorkItemError({
            code: "persistence",
            message: "Issue creation action was not saved.",
          });
        return yield* items.mutate(yield* decodeCommandJson(action[0].payload_json));
      },
      Effect.mapError((cause) =>
        isWorkItemError(cause)
          ? cause
          : new WorkItemError({
              code: "execution",
              message: "Could not prepare issue creation. Check the project source and provider.",
              cause,
            }),
      ),
    );
    return { createIssue };
  }),
);

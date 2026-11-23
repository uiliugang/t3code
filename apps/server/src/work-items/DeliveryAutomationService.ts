import {
  CommandId,
  WorkItem,
  WorkItemCommandInput,
  IssueSource,
  type WorkItemCreateIssueInput,
  WorkItemError,
  WorkItemIssueInput,
  WorkItemIssueResult,
  BranchIssueRef,
  RequirementIssueError,
  ThreadId,
  parseBranchIssueUrl,
  type WorkItemMutationResult,
} from "@t3tools/contracts";
import { readMis } from "@t3tools/source-control-meituan/shared/definition";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Issues from "../sourceControl/IssueService.ts";
import * as WorkItems from "./WorkItemService.ts";
import * as Providers from "../provider/ProviderInstanceRegistry.ts";
import * as Settings from "../serverSettings.ts";
import { orchestrationV2WorktreePending } from "@t3tools/shared/orchestrationV2ThreadError";

const decodeItemJson = Schema.decodeEffect(Schema.fromJsonString(WorkItem));
const encodeSourceJson = Schema.encodeEffect(Schema.fromJsonString(IssueSource));
const encodeCommandJson = Schema.encodeEffect(Schema.fromJsonString(WorkItemCommandInput));
const decodeCommandJson = Schema.decodeEffect(Schema.fromJsonString(WorkItemCommandInput));
const isWorkItemError = Schema.is(WorkItemError);
const isRequirementIssueError = Schema.is(RequirementIssueError);
const decodeSourceJson = Schema.decodeEffect(Schema.fromJsonString(IssueSource));
const decodeIssueJson = Schema.decodeEffect(Schema.fromJsonString(BranchIssueRef));
const encodeIssueJson = Schema.encodeEffect(Schema.fromJsonString(BranchIssueRef));
const mepTimeZone = DateTime.zoneMakeNamedUnsafe("Asia/Shanghai");

export class DeliveryAutomationService extends Context.Service<
  DeliveryAutomationService,
  {
    readonly createIssue: (
      input: WorkItemCreateIssueInput,
    ) => Effect.Effect<WorkItemMutationResult, WorkItemError>;
    readonly issueAction: (
      input: WorkItemIssueInput,
      callerThreadId: ThreadId,
    ) => Effect.Effect<typeof WorkItemIssueResult.Type, WorkItemError>;
  }
>()("t3/work-items/DeliveryAutomationService") {}

export const layer = Layer.effect(
  DeliveryAutomationService,
  Effect.gen(function* () {
    const items = yield* WorkItems.WorkItemService;
    const threads = yield* Threads.ThreadManagementService;
    const issues = yield* Issues.IssueService;
    const sql = yield* SqlClient.SqlClient;
    const providers = yield* Providers.ProviderInstanceRegistry;
    const settings = yield* Settings.ServerSettingsService;
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
          const parentId = thread.lineage.sideChat
            ? (thread.lineage.parentThreadId ?? thread.id)
            : thread.id;
          const parent = yield* threads.getThreadRecords(parentId, ["runs"]);
          if (
            parent.thread.lineage.sideChat ||
            parent.thread.lineage.relationshipToParent === "subagent" ||
            parent.thread.delegatedFrom
          )
            return yield* new WorkItemError({
              code: "invalid_request",
              message: "Create issues from a top-level conversation.",
            });
          if (orchestrationV2WorktreePending(parent.thread.worktreePath, parent.runs))
            return yield* new WorkItemError({
              code: "invalid_request",
              message: "Wait for the conversation's worktree to finish preparing, then try again.",
            });
          const instance = yield* providers.getInstance(thread.modelSelection.instanceId);
          const capabilities = instance
            ? yield* instance.orchestrationAdapter.getCapabilities()
            : undefined;
          if (capabilities?.runtimePolicy.supportsReadOnly !== true)
            return yield* new WorkItemError({
              code: "invalid_request",
              message: "Choose a provider that supports read-only side chats, then try again.",
            });
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
        let mepGuidance = "";
        if (input.source.provider === "meituan") {
          const mis = yield* settings.getSettings.pipe(
            Effect.map((saved) => readMis(saved.sourceControlHosts.meituan)),
            Effect.orElseSucceed(() => ""),
          );
          const today = DateTime.setZone(yield* DateTime.now, mepTimeZone);
          const weekday = DateTime.toParts(today).weekDay || 7;
          const friday = DateTime.formatIsoDate(DateTime.add(today, { days: 5 - weekday }));
          mepGuidance = [
            "For a Meituan REQUIREMENT, preserve any explicit assignee or expected development end date from the conversation.",
            mis
              ? `The destination environment's Meituan integration identifies the user as MIS "${mis}". Use it in action.assignees when the user says "assign to me" or gives no assignee; do not also send fields.assigned.`
              : 'If the assignee is omitted or the user says "assign to me", ask for the MIS because the destination environment has no available Meituan MIS. Do not guess from local usernames or messages.',
            `In Asia/Shanghai, today is ${DateTime.formatIsoDate(today)} and this Friday is ${friday}. For the expected development end date (预计开发结束), use action.fields.customField13642 with a YYYY-MM-DD value, not the task's expectClose or the release date. Use this Friday when no date is specified; if it has passed, ask for a date rather than submitting a past default.`,
          ].join(" ");
        }
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
              sideChatOf: thread.lineage.sideChat
                ? (thread.lineage.parentThreadId ?? thread.id)
                : thread.id,
              assignment: [
                `Create one external issue for this conversation using ONLY ${sourceJson}. Use work_item_issue with id ${item.id}: metadata reads the required subtype and fields; create submits the draft and links it automatically. Ask only for missing required fields unless the guidance below requires clarification. If creation is uncertain, check the platform and use recover with its canonical URL; never blindly retry. This side chat remains read-only for code. Do not use a CLI, modify code, start development, or create another task.`,
                mepGuidance,
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
        };
        yield* sql`INSERT OR IGNORE INTO work_item_delivery_actions (work_item_id, scope_revision, kind, payload_json) VALUES (${item.id}, 0, 'issue_source', ${sourceJson})`;
        yield* sql`INSERT OR IGNORE INTO work_item_delivery_actions (work_item_id, scope_revision, kind, payload_json) VALUES (${item.id}, 0, 'create_issue', ${yield* encodeCommandJson(start)})`;
        const action = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM work_item_delivery_actions WHERE work_item_id = ${item.id} AND scope_revision = 0 AND kind = 'create_issue'`;
        if (!action[0])
          return yield* new WorkItemError({
            code: "persistence",
            message: "Issue creation action was not saved.",
          });
        let startAction = yield* decodeCommandJson(action[0].payload_json);
        const current = yield* items.get(item.id);
        if (current.delivery) return { item: current };
        const execution = current.executions.at(-1);
        if (startAction.type === "start" && execution?.runId) {
          const sideChat = yield* threads.getThreadShell(execution.threadId);
          if (sideChat === null || sideChat.deletedAt !== null) {
            startAction = {
              ...startAction,
              commandId: CommandId.make(`${creationKey}:start:${execution.id}`),
              specRevision: current.specRevision,
            };
          }
        }
        const result = yield* items.mutate(startAction);
        return { item: yield* items.get(result.item.id) };
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
    const issueAction = Effect.fn("DeliveryAutomationService.issueAction")(
      function* (input: WorkItemIssueInput, callerThreadId: ThreadId) {
        const item = yield* items.get(input.id);
        if (!item.executions.some((entry) => entry.threadId === callerThreadId && entry.sideChatOf))
          return yield* new WorkItemError({
            code: "invalid_request",
            message: "Use the issue creation side chat assigned to this task.",
          });
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM work_item_delivery_actions WHERE work_item_id = ${item.id} AND scope_revision = 0 AND kind = 'issue_source'`;
        if (!rows[0])
          return yield* new WorkItemError({
            code: "invalid_request",
            message: "This task has no issue creation authorization.",
          });
        const source = yield* decodeSourceJson(rows[0].payload_json);
        const target = {
          projectId: item.projectId,
          provider: source.provider,
          scope: source.scope,
          host: source.host,
        };
        const action = input.action;
        if (action.operation === "metadata")
          return yield* issues.metadata({ ...action, ...target });
        if (item.delivery?.issue) return { item };
        let issue: BranchIssueRef;
        const created = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM work_item_delivery_actions WHERE work_item_id = ${item.id} AND scope_revision = 0 AND kind = 'issue_created'`;
        if (created[0]) issue = yield* decodeIssueJson(created[0].payload_json);
        else {
          if (action.operation === "recover") {
            const parsed = parseBranchIssueUrl(action.url);
            if (
              !parsed ||
              parsed.provider !== source.provider ||
              parsed.repository !== source.scope ||
              new URL(parsed.url).hostname !== source.host
            )
              return yield* new WorkItemError({
                code: "invalid_request",
                message: "Use an issue URL from this task's configured destination.",
              });
            yield* issues.read({ ...target, id: parsed.id });
            issue = parsed;
          } else {
            const claimed = yield* sql<{
              work_item_id: string;
            }>`INSERT OR IGNORE INTO work_item_delivery_actions (work_item_id, scope_revision, kind, payload_json) VALUES (${item.id}, 0, 'issue_create_attempt', '{}') RETURNING work_item_id`;
            if (!claimed[0])
              return yield* new WorkItemError({
                code: "execution",
                message:
                  "Creation may have succeeded. Check the platform and recover its canonical URL; do not create again.",
              });
            const result = yield* issues.create({ ...action, ...target }).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  if (error.reason !== "outcome-unknown")
                    yield* sql`DELETE FROM work_item_delivery_actions WHERE work_item_id = ${item.id} AND scope_revision = 0 AND kind = 'issue_create_attempt'`;
                  return yield* error;
                }),
              ),
            );
            issue = {
              provider: source.provider,
              repository: source.scope,
              id: result.id,
              url: result.url,
            };
          }
          yield* sql`INSERT OR IGNORE INTO work_item_delivery_actions (work_item_id, scope_revision, kind, payload_json) VALUES (${item.id}, 0, 'issue_created', ${yield* encodeIssueJson(issue)})`;
        }
        return yield* items.mutate({
          type: "link_issue",
          commandId: CommandId.make(`issue-created:${item.id}:${issue.id}`),
          id: item.id,
          expectedVersion: (yield* items.get(item.id)).version,
          issue,
        });
      },
      Effect.mapError((cause) =>
        isWorkItemError(cause)
          ? cause
          : new WorkItemError({
              code: "execution",
              message: isRequirementIssueError(cause)
                ? `${cause.message}${cause.fields ? ` ${JSON.stringify(cause.fields)}` : ""}`
                : "Could not complete issue creation.",
              cause,
            }),
      ),
    );
    return { createIssue, issueAction };
  }),
);

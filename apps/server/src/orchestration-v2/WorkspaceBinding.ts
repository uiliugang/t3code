import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export class WorkspaceBindingError extends Schema.TaggedError<WorkspaceBindingError>()(
  "WorkspaceBindingError",
  {
    threadId: ThreadId,
    reason: Schema.Literals([
      "stale-revision",
      "wrong-project",
      "busy",
      "invalid-primary",
      "invalid-preparing-run",
    ]),
  },
) {
  override get message(): string {
    return `Cannot bind the thread workspace (${this.reason}).`;
  }
}

export function planWorkspaceBinding(input: {
  readonly command: Extract<
    OrchestrationV2ServerCommand,
    { readonly type: "thread.workspace.bind" }
  >;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "providerSessions" | "runtimeRequests"
  >;
  readonly now: DateTime.Utc;
}): Result.Result<OrchestrationV2AppThread, WorkspaceBindingError> {
  const { command, projection, now } = input;
  const { thread } = projection;
  const reject = (reason: WorkspaceBindingError["reason"]) =>
    Result.fail(new WorkspaceBindingError({ threadId: thread.id, reason }));
  if (thread.projectId !== command.workspace.projectId) return reject("wrong-project");
  if (
    (thread.workspace?.id ?? null) !== command.expectedWorkspaceRevisionId ||
    command.workspace.previousRevisionId !== command.expectedWorkspaceRevisionId ||
    thread.workspace?.id === command.workspace.id
  )
    return reject("stale-revision");
  if (
    command.preparingRunId !== undefined &&
    !projection.runs.some((run) => run.id === command.preparingRunId && run.status === "preparing")
  ) {
    return reject("invalid-preparing-run");
  }
  if (
    thread.deletedAt !== null ||
    thread.archivedAt !== null ||
    projection.runs.some(
      (run) =>
        ["queued", "preparing", "starting", "running", "waiting"].includes(run.status) &&
        !(run.id === command.preparingRunId && run.status === "preparing"),
    ) ||
    projection.providerSessions.some((session) => session.status !== "stopped") ||
    projection.runtimeRequests.some((request) => request.status === "pending")
  )
    return reject("busy");
  const primary = command.workspace.bindings.find(
    (binding) => binding.rootId === command.workspace.primaryRootId,
  );
  const primaryResource = command.workspace.resources.find(
    (resource) => resource.id === primary?.resourceId,
  );
  if (!primary || !primaryResource) return reject("invalid-primary");
  return Result.succeed({
    ...thread,
    workspace: command.workspace,
    projectWorkspaceRoot: primary.sourcePathAtBind,
    worktreePath: command.workspace.mode === "isolated" ? primaryResource.checkoutRoot : null,
    branch: primary.launchBranch,
    activeProviderThreadId: null,
    updatedAt: now,
  });
}

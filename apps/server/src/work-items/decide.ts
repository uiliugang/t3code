import {
  WorkItemError,
  type WorkItem,
  type WorkItemCommandInput,
  type WorkItemExecution,
} from "@t3tools/contracts";

export function executionIsActive(execution: WorkItemExecution): boolean {
  return !["completed", "failed", "cancelled"].includes(execution.status);
}

export function decideWorkItem(input: {
  item: WorkItem;
  command: Exclude<WorkItemCommandInput, { type: "create" }>;
  now: string;
  executions?: ReadonlyArray<WorkItemExecution>;
}): WorkItem {
  const { item, command, now } = input;
  if ("expectedVersion" in command && command.expectedVersion !== item.version) {
    throw new WorkItemError({
      code: "conflict",
      message: "This task changed. Reload it before saving.",
    });
  }
  const invalid = (message: string): never => {
    throw new WorkItemError({ code: "invalid_state", message });
  };
  if (item.archived && command.type !== "archive") invalid("Restore this task before changing it.");
  switch (command.type) {
    case "reopen_delivery": {
      if (item.delivery === undefined || !item.delivery.evidence.anomaly)
        return invalid("Confirm a delivery exception before reopening the issue.");
      return {
        ...item,
        delivery: {
          ...item.delivery,
          reopenRequest: { scopeRevision: item.delivery.scope.revision, state: command.state },
        },
        version: item.version + 1,
        updatedAt: now,
      };
    }
    case "completion_state":
    case "delivery_exception":
    case "release_plans":
    case "unlink_issue_thread": {
      if (item.delivery === undefined) return invalid("Link an external issue first.");
      return {
        ...item,
        sources:
          command.type === "unlink_issue_thread"
            ? item.sources.filter((source) => source.threadId !== command.threadId)
            : item.sources,
        delivery: {
          ...item.delivery,
          ...(command.type === "completion_state" ? { completionState: command.state } : {}),
          ...(command.type === "unlink_issue_thread"
            ? {
                dismissedThreadIds: [
                  ...new Set([...(item.delivery.dismissedThreadIds ?? []), command.threadId]),
                ],
              }
            : {}),
          evidence: {
            ...item.delivery.evidence,
            ...(command.type === "release_plans" ? { planIds: [...new Set(command.planIds)] } : {}),
            ...(command.type === "delivery_exception" ? { anomaly: command.reason } : {}),
          },
        },
        version: item.version + 1,
        updatedAt: now,
      };
    }
    case "link_issue": {
      if (item.delivery !== undefined && item.delivery.issue.url !== command.issue.url)
        return invalid("This work item already has an external issue.");
      return {
        ...item,
        delivery: item.delivery ?? {
          issue: command.issue,
          scope: {
            revision: 1,
            confirmedRevision: null,
            requiredPullRequests: [],
            changedServices: [],
          },
          evidence: { pullRequests: [], releases: [], planIds: [], anomaly: null },
        },
        version: item.version + 1,
        updatedAt: now,
      };
    }
    case "delivery_scope": {
      if (item.delivery === undefined) return invalid("Link an external issue first.");
      if (
        command.requiredPullRequests.some((value) => {
          const url = URL.parse(value);
          return url === null || url.protocol !== "https:" || !!url.username || !!url.password;
        })
      )
        return invalid("Use HTTPS pull request links without embedded credentials.");
      if (
        command.changedServices.some(
          (service) => !command.requiredPullRequests.includes(service.revision),
        )
      )
        return invalid("Each changed service must reference a necessary delivery pull request.");
      if (new Set(command.requiredPullRequests).size !== command.requiredPullRequests.length)
        return invalid("Include each necessary pull request once.");
      return {
        ...item,
        executions: item.executions.map((execution) =>
          execution.deliveryRevision !== undefined && executionIsActive(execution)
            ? { ...execution, stopRequested: true, status: "stopping" as const }
            : execution,
        ),
        delivery: {
          ...item.delivery,
          evidence: {
            ...item.delivery.evidence,
            anomaly:
              item.delivery.syncedRevision !== undefined
                ? "The delivery scope changed after completion. Confirm whether to reopen the issue."
                : item.delivery.evidence.anomaly,
          },
          scope: {
            revision: item.delivery.scope.revision + 1,
            confirmedRevision: null,
            requiredPullRequests: command.requiredPullRequests,
            changedServices: command.changedServices,
          },
        },
        version: item.version + 1,
        updatedAt: now,
      };
    }
    case "confirm_scope": {
      if (item.delivery === undefined || command.scopeRevision !== item.delivery.scope.revision)
        return invalid("Confirm the current delivery scope.");
      return {
        ...item,
        delivery: {
          ...item.delivery,
          scope: { ...item.delivery.scope, confirmedRevision: command.scopeRevision },
        },
        version: item.version + 1,
        updatedAt: now,
      };
    }
    case "update": {
      const changed =
        JSON.stringify([
          item.description,
          item.constraints,
          item.acceptanceCriteria,
          item.sources,
        ]) !==
        JSON.stringify([
          command.description,
          command.constraints,
          command.acceptanceCriteria,
          command.sources,
        ]);
      if (changed && item.status === "done")
        invalid("Reopen this task before changing its requirements.");
      return {
        ...item,
        title: command.title,
        description: command.description,
        constraints: command.constraints,
        acceptanceCriteria: command.acceptanceCriteria,
        priority: command.priority,
        sources: command.sources,
        specRevision: item.specRevision + Number(changed),
        status: changed && item.status === "in_review" ? "in_progress" : item.status,
        submission: changed ? null : item.submission,
        reviewFeedback: changed ? "" : item.reviewFeedback,
        version: item.version + 1,
        updatedAt: now,
      };
    }
    case "start":
      if (
        command.deliveryRevision !== undefined &&
        (item.delivery?.scope.revision !== command.deliveryRevision ||
          item.delivery.scope.confirmedRevision !== command.deliveryRevision)
      )
        invalid("The delivery scope changed before this automatic action started.");
      if (command.specRevision !== item.specRevision)
        invalid("Start from the current requirements version.");
      if (item.status === "done") invalid("Reopen this task before starting another agent.");
      return {
        ...item,
        status: "in_progress",
        submission: null,
        executions: [...item.executions, ...(input.executions ?? [])],
        version: item.version + 1,
        updatedAt: now,
      };
    case "stop": {
      if (
        command.executionId !== undefined &&
        !item.executions.some((execution) => execution.id === command.executionId)
      ) {
        invalid("That agent execution does not belong to this task.");
      }
      return {
        ...item,
        executions: item.executions.map((execution) =>
          executionIsActive(execution) &&
          (command.executionId === undefined || command.executionId === execution.id)
            ? { ...execution, stopRequested: true, status: "stopping", updatedAt: now }
            : execution,
        ),
        updatedAt: now,
      };
    }
    case "report": {
      const execution = item.executions.find((entry) => entry.id === command.executionId);
      if (!execution) return invalid("That agent execution does not belong to this task.");
      if (execution.specRevision !== command.specRevision)
        invalid("The report requirements version does not match its execution.");
      return {
        ...item,
        executions: item.executions.map((entry) =>
          entry.id === command.executionId
            ? {
                ...entry,
                summary: command.summary,
                artifacts: command.artifacts,
                submitted: command.submitted,
                updatedAt: now,
              }
            : entry,
        ),
        updatedAt: now,
      };
    }
    case "submit": {
      if (item.status === "done") invalid("Reopen this task before submitting another result.");
      if (command.specRevision !== item.specRevision)
        invalid("Only results for the current requirements can be submitted.");
      if (item.executions.some(executionIsActive))
        invalid("Wait for every agent to finish, or stop the remaining agents before review.");
      if (
        command.executionIds.length === 0 &&
        command.summary.trim().length === 0 &&
        command.artifacts.length === 0
      )
        invalid("Describe the delivery or select an agent result before review.");
      const ids = new Set(command.executionIds);
      if (ids.size !== command.executionIds.length) invalid("Select each execution once.");
      for (const id of ids) {
        const execution = item.executions.find((entry) => entry.id === id);
        if (
          !execution ||
          execution.specRevision !== item.specRevision ||
          execution.status !== "completed"
        ) {
          invalid("Only completed executions for the current requirements can be selected.");
        }
      }
      return {
        ...item,
        status: "in_review",
        submission: {
          specRevision: command.specRevision,
          executionIds: command.executionIds,
          summary: command.summary,
          artifacts: command.artifacts,
          executionEvidence: item.executions
            .filter((execution) => ids.has(execution.id))
            .map((execution) => ({
              executionId: execution.id,
              threadId: execution.threadId,
              specRevision: execution.specRevision,
              workspacePath: execution.resolvedWorkspacePath ?? null,
              branch: execution.branch ?? null,
              checkpointId: execution.checkpointId ?? null,
              checkpointRef: execution.checkpointRef ?? null,
              capturedAt: execution.codeEvidenceCapturedAt ?? now,
            })),
          createdAt: now,
        },
        version: item.version + 1,
        updatedAt: now,
      };
    }
    case "review":
      if (item.status !== "in_review" || item.submission?.specRevision !== item.specRevision)
        invalid("Submit the current requirements for review first.");
      if (item.executions.some(executionIsActive))
        invalid("Agents are still working on this task.");
      return {
        ...item,
        status: command.decision === "accept" ? "done" : "in_progress",
        acceptedAt: command.decision === "accept" ? now : null,
        submission: command.decision === "changes" ? null : item.submission,
        reviewFeedback: command.decision === "changes" ? command.note : "",
        version: item.version + 1,
        updatedAt: now,
      };
    case "reopen":
      if (item.status !== "done") invalid("Only completed tasks can be reopened.");
      return {
        ...item,
        status: "todo",
        acceptedAt: null,
        submission: null,
        version: item.version + 1,
        updatedAt: now,
      };
    case "move":
      if (item.status === "done" || item.status === "in_review")
        invalid("Use review or reopen to change this task status.");
      if (command.status === "todo" && item.executions.some(executionIsActive))
        invalid("Stop active agents before moving this task to backlog.");
      return { ...item, status: command.status, version: item.version + 1, updatedAt: now };
    case "archive":
      if (command.archived && item.executions.some(executionIsActive))
        invalid("Stop active agents before archiving this task.");
      return { ...item, archived: command.archived, version: item.version + 1, updatedAt: now };
  }
}

export function buildWorkItemPrompt(item: WorkItem, execution: WorkItemExecution): string {
  return [
    `Task: ${item.title}`,
    `Task ID: ${item.id}`,
    `Execution ID: ${execution.id}`,
    `Requirements revision: ${execution.specRevision}`,
    "",
    execution.specSnapshot.description,
    "",
    "Constraints:",
    ...execution.specSnapshot.constraints.map((line) => `- ${line}`),
    "Acceptance criteria:",
    ...execution.specSnapshot.acceptanceCriteria.map((line) => `- ${line}`),
    "Previous review feedback:",
    item.reviewFeedback ?? "",
    "Your assignment:",
    execution.assignment || "Complete this requirement and explain what you delivered.",
    "",
    "Work within this requirements revision. Other agents may work independently on the same task in separate workspaces.",
    "Report progress and submit your result with the work_item tools when available. Report artifacts and actual validation. Human acceptance completes the task.",
    "Source conversations:",
    ...item.sources.map(
      (source) =>
        `- ${source.title}: ${source.threadId}${source.messageId ? `, message ${source.messageId}` : ""}`,
    ),
  ].join("\n");
}

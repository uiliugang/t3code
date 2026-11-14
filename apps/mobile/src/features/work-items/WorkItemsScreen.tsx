import { DraftFillButton } from "../requirements/DraftFillButton";
import { ProjectTag, Disclosure } from "../requirements/RequirementPrimitives";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  MessageId,
  type ModelSelection,
  type RuntimeMode,
  type ThreadId,
  type WorkItem,
  type WorkItemCandidate,
  type WorkItemCommandInput,
  type WorkItemExecutionId,
  type WorkItemId,
  type WorkItemParticipant,
  type WorkItemSource,
} from "@t3tools/contracts";
import {
  buildWorkItemContinuePrompt,
  selectWorkItemResultIds,
  workItemExecutionIsActive,
  WORK_ITEM_STATUS_LABELS,
} from "@t3tools/client-runtime/work-item";
import { useState, type ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { buildModelOptions } from "../../lib/modelOptions";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import {
  appendComposerDraftText,
  createNewTaskDraft,
  getComposerDraftSnapshot,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { IssuePicker } from "../requirements/IssuePicker";
import { requestThreadMessageJump } from "../threads/threadMessageJump";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";

export type WorkItemsRouteParams = {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly sourceThreadId?: ThreadId;
  readonly sourceTitle?: string;
  readonly sourceMessageId?: string;
  readonly sourceText?: string;
  readonly itemId?: WorkItemId;
};

const commandId = () => CommandId.make(uuidv4());
const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

function displayLines(values: ReadonlyArray<string>) {
  const occurrences = new Map<string, number>();
  return values.map((text) => {
    const occurrence = occurrences.get(text) ?? 0;
    occurrences.set(text, occurrence + 1);
    return { key: JSON.stringify([text, occurrence]), text };
  });
}

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <View className="gap-3 border-t border-border-subtle pt-4">
      <Text className="text-sm font-t3-semibold">{props.title}</Text>
      {props.children}
    </View>
  );
}

function Field(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly multiline?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <AppTextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        multiline={props.multiline}
        readOnly={props.disabled}
        textAlignVertical={props.multiline ? "top" : "center"}
      />
    </View>
  );
}

type RunCommand = (input: WorkItemCommandInput) => Promise<WorkItem | null>;

export function TaskEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly source?: WorkItemSource;
  readonly item: WorkItem | null;
  readonly initialDescription?: string;
  readonly disabled: boolean;
  readonly run: RunCommand;
  readonly onCancel: () => void;
  readonly onSaved: (item: WorkItem) => void;
}) {
  const t = useUiTranslation();
  const [baseVersion] = useState(props.item?.version);
  const [title, setTitle] = useState(props.item?.title ?? props.source?.title ?? "");
  const [description, setDescription] = useState(
    props.item?.description ?? props.initialDescription ?? "",
  );
  const [constraints, setConstraints] = useState(props.item?.constraints.join("\n") ?? "");
  const [criteria, setCriteria] = useState(props.item?.acceptanceCriteria.join("\n") ?? "");
  const [priority, setPriority] = useState(props.item?.priority ?? "P2");
  const [generating, setGenerating] = useState(false);
  const disabled = props.disabled || generating;
  const save = async () => {
    const fields = {
      title: title.trim(),
      description,
      constraints: lines(constraints),
      acceptanceCriteria: lines(criteria),
      priority,
      sources: props.item?.sources ?? (props.source ? [props.source] : []),
    };
    const item =
      props.item && baseVersion !== undefined
        ? await props.run({
            type: "update",
            commandId: commandId(),
            id: props.item.id,
            expectedVersion: baseVersion,
            ...fields,
          })
        : await props.run({
            type: "create",
            commandId: commandId(),
            projectId: props.projectId,
            ...fields,
          });
    if (item) props.onSaved(item);
  };
  return (
    <Section title={t(props.item ? "Edit task" : "New task")}>
      <DraftFillButton
        environmentId={props.environmentId}
        projectId={props.projectId}
        context={[title, description, constraints, criteria].filter(Boolean).join("\n\n")}
        disabled={disabled}
        onBusyChange={setGenerating}
        onDraft={(draft) => {
          setTitle(draft.title);
          setDescription(draft.description);
          setConstraints(draft.constraints.join("\n"));
          setCriteria(draft.acceptanceCriteria.join("\n"));
        }}
      />
      <Field label={t("Title")} value={title} onChange={setTitle} disabled={disabled} />
      <Field
        label={t("Goal")}
        value={description}
        onChange={setDescription}
        multiline
        disabled={disabled}
      />
      <Field
        label={t("Constraints (one per line)")}
        value={constraints}
        onChange={setConstraints}
        multiline
        disabled={disabled}
      />
      <Field
        label={t("Acceptance criteria (one per line)")}
        value={criteria}
        onChange={setCriteria}
        multiline
        disabled={disabled}
      />
      <IssuePicker
        label={t("Priority")}
        value={priority}
        options={["P0", "P1", "P2", "P3"].map((value) => ({ value, label: value }))}
        onChange={(value) => {
          if (value === "P0" || value === "P1" || value === "P2" || value === "P3")
            setPriority(value);
        }}
        disabled={disabled}
      />
      {props.source ? (
        <Text className="text-xs text-foreground-muted">
          {t("Source")}: {props.source.title}
        </Text>
      ) : null}
      {props.item && props.item.version !== baseVersion ? (
        <Text className="text-danger">
          {t("This task changed on another device. Your draft has been preserved.")}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-3">
        <Button
          label={t("Save")}
          tone="primary"
          disabled={
            disabled || !title.trim() || (props.item !== null && props.item.version !== baseVersion)
          }
          onPress={() => void save()}
        />
        <Button label={t("Cancel")} disabled={disabled} onPress={props.onCancel} />
      </View>
    </Section>
  );
}

export function CandidateCard(props: {
  readonly candidate: WorkItemCandidate;
  readonly disabled: boolean;
  readonly onCreate: () => void;
  readonly onIgnore: () => void;
}) {
  const t = useUiTranslation();
  return (
    <View className="gap-2 border-t border-border-subtle py-3">
      <Text className="font-t3-medium">{props.candidate.title}</Text>
      <Text className="text-sm text-foreground-muted" numberOfLines={3}>
        {props.candidate.description}
      </Text>
      <View className="flex-row flex-wrap gap-3">
        <Button label={t("Create task")} disabled={props.disabled} onPress={props.onCreate} />
        <Button label={t("Ignore")} disabled={props.disabled} onPress={props.onIgnore} />
      </View>
    </View>
  );
}

export function TaskDetail(props: {
  readonly item: WorkItem;
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly run: RunCommand;
  readonly onBack: () => void;
}) {
  const t = useUiTranslation();
  const { item, environmentId } = props;
  const project = useProjects().find(
    (entry) => entry.environmentId === environmentId && entry.id === item.projectId,
  );
  const selectDetail = useSelectWorkspaceDetail();
  const [editing, setEditing] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [summary, setSummary] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [artifacts, setArtifacts] = useState("");
  const [selectedExecutions, setSelectedExecutions] = useState<ReadonlyArray<WorkItemExecutionId>>(
    [],
  );
  const active = item.executions.some(workItemExecutionIsActive);
  const openThread = (threadId: ThreadId, messageId?: string) => {
    if (messageId)
      requestThreadMessageJump(scopedThreadKey(environmentId, threadId), MessageId.make(messageId));
    selectDetail({ name: "Thread", params: { environmentId, threadId } });
  };
  const fillDraft = async (threadId?: ThreadId) => {
    await waitForComposerDraftsLoaded();
    const key = threadId
      ? scopedThreadKey(environmentId, threadId)
      : createNewTaskDraft({ environmentId, projectId: item.projectId });
    const existing = getComposerDraftSnapshot(key).text;
    appendComposerDraftText(key, `${existing ? "\n\n" : ""}${buildWorkItemContinuePrompt(item)}`);
    if (threadId) openThread(threadId);
    else
      selectDetail({
        name: "Thread",
        params: { draft: { environmentId, projectId: item.projectId, draftId: key } },
      });
  };
  const submit = async () => {
    const updated = await props.run({
      type: "submit",
      commandId: commandId(),
      id: item.id,
      expectedVersion: item.version,
      specRevision: item.specRevision,
      executionIds: selectWorkItemResultIds(item, selectedExecutions),
      summary,
      artifacts: lines(artifacts),
    });
    if (updated) {
      setSummary("");
      setArtifacts("");
      setSelectedExecutions([]);
    }
  };

  if (editing)
    return (
      <TaskEditor
        environmentId={props.environmentId}
        item={item}
        projectId={item.projectId}
        disabled={props.disabled}
        run={props.run}
        onCancel={() => setEditing(false)}
        onSaved={() => setEditing(false)}
      />
    );

  return (
    <>
      <View className="flex-row flex-wrap gap-3">
        <Button label={t("Back to tasks")} icon="chevron.left" onPress={props.onBack} />
        <Button label={t("Edit task")} disabled={props.disabled} onPress={() => setEditing(true)} />
      </View>
      <ProjectTag title={project?.title ?? item.projectId} />
      <Text className="text-xl font-t3-semibold">{item.title}</Text>
      <Text className="text-foreground-muted">
        {t(WORK_ITEM_STATUS_LABELS[item.status])} · {item.priority} · v{item.specRevision}
      </Text>
      <Disclosure title={t("Goal")}>
        <Text selectable>{item.description || t("No description.")}</Text>
      </Disclosure>
      {item.constraints.length ? (
        <Disclosure title={t("Constraints")}>
          {displayLines(item.constraints).map((line) => (
            <Text key={line.key}>• {line.text}</Text>
          ))}
        </Disclosure>
      ) : null}
      <Disclosure title={t("Acceptance criteria")}>
        {item.acceptanceCriteria.length ? (
          displayLines(item.acceptanceCriteria).map((line) => (
            <Text key={line.key}>• {line.text}</Text>
          ))
        ) : (
          <Text className="text-foreground-muted">{t("No acceptance criteria yet.")}</Text>
        )}
      </Disclosure>
      {item.reviewFeedback ? (
        <Section title={t("Review notes")}>
          <Text selectable>{item.reviewFeedback}</Text>
        </Section>
      ) : null}
      <Section title={t("Sources")}>
        {item.sources.map((source) => (
          <Button
            key={source.threadId}
            label={source.title}
            icon="text.bubble"
            onPress={() => openThread(source.threadId, source.messageId)}
          />
        ))}
        <Button
          label={t("Continue in a new chat")}
          disabled={props.busy}
          onPress={() => void fillDraft()}
        />
        {item.sources[0] ? (
          <Button
            label={t("Continue in source chat")}
            disabled={props.busy}
            onPress={() => void fillDraft(item.sources[0]?.threadId)}
          />
        ) : null}
      </Section>
      <Section title={t("Agents")}>
        <View className="flex-row flex-wrap gap-3">
          <Button
            label={t("Add agents")}
            icon="plus"
            disabled={props.disabled || item.archived || item.status === "done"}
            onPress={() => setAssigning(!assigning)}
          />
          {active ? (
            <Button
              label={t("Stop all agents")}
              tone="danger"
              disabled={props.disabled}
              onPress={() => void props.run({ type: "stop", commandId: commandId(), id: item.id })}
            />
          ) : null}
        </View>
        {assigning ? (
          <AgentAssignment
            environmentId={environmentId}
            item={item}
            disabled={props.disabled}
            run={props.run}
            onStarted={() => setAssigning(false)}
          />
        ) : null}
        {item.executions.map((execution) => (
          <View key={execution.id} className="gap-2 border-t border-border-subtle py-3">
            <Text className="font-t3-medium">
              {execution.modelSelection.instanceId} · {execution.modelSelection.model}
            </Text>
            <Text>{execution.assignment || t("Complete the task")}</Text>
            <Text className="text-sm text-foreground-muted">
              {t(execution.status)} · v{execution.specRevision}
              {execution.specRevision !== item.specRevision
                ? ` · ${t("Outdated specification")}`
                : ""}
            </Text>
            <Text selectable className="text-sm text-foreground-muted">
              {t("Workspace path")}: {execution.resolvedWorkspacePath ?? t("Not available")}
            </Text>
            <Text selectable className="text-sm text-foreground-muted">
              {t("Branch")}: {execution.branch ?? t("Not available")}
            </Text>
            <Text selectable className="text-sm text-foreground-muted">
              {t("Checkpoint reference")}: {execution.checkpointRef ?? t("Not available")}
            </Text>
            {execution.codeEvidenceCapturedAt ? (
              <Text className="text-sm text-foreground-muted">
                {t("Evidence captured")}: {execution.codeEvidenceCapturedAt}
              </Text>
            ) : null}
            {execution.error ? <Text className="text-danger">{execution.error}</Text> : null}
            {execution.summary ? <Text selectable>{execution.summary}</Text> : null}
            {displayLines(execution.artifacts).map((artifact) => (
              <Text key={artifact.key} selectable className="text-sm text-foreground-muted">
                {artifact.text}
              </Text>
            ))}
            <View className="flex-row flex-wrap gap-3">
              <Button label={t("Open chat")} onPress={() => openThread(execution.threadId)} />
              {!workItemExecutionIsActive(execution) && !item.archived && item.status !== "done" ? (
                <Button
                  label={t("Retry agent")}
                  disabled={props.disabled}
                  onPress={() =>
                    void props.run({
                      type: "start",
                      commandId: commandId(),
                      id: item.id,
                      specRevision: item.specRevision,
                      participants: [
                        {
                          assignment: execution.assignment,
                          modelSelection: execution.modelSelection,
                          runtimeMode: execution.runtimeMode,
                          interactionMode: execution.interactionMode,
                          workspaceStrategy: execution.workspaceStrategy,
                        },
                      ],
                    })
                  }
                />
              ) : null}
              {workItemExecutionIsActive(execution) ? (
                <Button
                  label={t(execution.stopRequested ? "Stopping..." : "Stop agent")}
                  tone="danger"
                  disabled={props.disabled || execution.stopRequested}
                  onPress={() =>
                    void props.run({
                      type: "stop",
                      commandId: commandId(),
                      id: item.id,
                      executionId: execution.id,
                    })
                  }
                />
              ) : null}
            </View>
            {execution.status === "completed" && execution.specRevision === item.specRevision ? (
              <ListToggleRow
                label={t("Use this result")}
                value={selectedExecutions.includes(execution.id)}
                disabled={props.disabled}
                onValueChange={(checked) =>
                  setSelectedExecutions((current) =>
                    checked
                      ? [...current, execution.id]
                      : current.filter((id) => id !== execution.id),
                  )
                }
              />
            ) : null}
          </View>
        ))}
      </Section>
      {item.submission ? (
        <Section title={t("Submitted result")}>
          <Text selectable>{item.submission.summary}</Text>
          {displayLines(item.submission.artifacts).map((artifact) => (
            <Text key={artifact.key} selectable>
              {artifact.text}
            </Text>
          ))}
          <Text className="text-sm text-foreground-muted">v{item.submission.specRevision}</Text>
          {item.submission.executionEvidence?.length ? (
            <>
              <Text className="font-t3-medium">{t("Selected execution evidence")}</Text>
              <Text className="text-sm text-foreground-muted">
                {t(
                  "These references were recorded at submission. Verify the integrated deliverable separately.",
                )}
              </Text>
              {item.submission.executionEvidence.map((evidence) => (
                <View
                  key={evidence.executionId}
                  className="gap-2 border-t border-border-subtle py-3"
                >
                  <Text selectable>
                    {t("Workspace path")}: {evidence.workspacePath ?? t("Not available")}
                  </Text>
                  <Text selectable>
                    {t("Branch")}: {evidence.branch ?? t("Not available")}
                  </Text>
                  <Text selectable>
                    {t("Checkpoint reference")}: {evidence.checkpointRef ?? t("Not available")}
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    v{evidence.specRevision} · {evidence.capturedAt}
                  </Text>
                  <Button label={t("Open chat")} onPress={() => openThread(evidence.threadId)} />
                </View>
              ))}
            </>
          ) : null}
          {item.status === "in_review" ? (
            <>
              <Field
                label={t("Review notes")}
                value={reviewNote}
                onChange={setReviewNote}
                multiline
                disabled={props.disabled}
              />
              <View className="flex-row flex-wrap gap-3">
                <Button
                  label={t("Accept task")}
                  tone="primary"
                  disabled={props.disabled || active}
                  onPress={() =>
                    void props.run({
                      type: "review",
                      commandId: commandId(),
                      id: item.id,
                      expectedVersion: item.version,
                      decision: "accept",
                      note: reviewNote,
                    })
                  }
                />
                <Button
                  label={t("Request changes")}
                  disabled={props.disabled || active}
                  onPress={() =>
                    void props.run({
                      type: "review",
                      commandId: commandId(),
                      id: item.id,
                      expectedVersion: item.version,
                      decision: "changes",
                      note: reviewNote,
                    })
                  }
                />
              </View>
            </>
          ) : null}
        </Section>
      ) : null}
      {!item.archived && item.status !== "done" && item.status !== "in_review" ? (
        <Section title={t("Submit for review")}>
          <Field
            label={t("Delivery summary")}
            value={summary}
            onChange={setSummary}
            multiline
            disabled={props.disabled}
          />
          <Field
            label={t("Artifacts (one per line)")}
            value={artifacts}
            onChange={setArtifacts}
            multiline
            disabled={props.disabled}
          />
          {active ? (
            <Text className="text-foreground-muted">
              {t("Wait for all agents to finish or stop them before submitting for review.")}
            </Text>
          ) : null}
          <Button
            label={t("Submit for review")}
            tone="primary"
            disabled={props.disabled || active || !summary.trim()}
            onPress={() => void submit()}
          />
        </Section>
      ) : null}
      <View className="flex-row flex-wrap gap-3">
        {item.status === "todo" || item.status === "in_progress" ? (
          <Button
            label={t(item.status === "todo" ? "Mark in progress" : "Move to to do")}
            disabled={props.disabled || item.archived || (active && item.status === "in_progress")}
            onPress={() =>
              void props.run({
                type: "move",
                commandId: commandId(),
                id: item.id,
                expectedVersion: item.version,
                status: item.status === "todo" ? "in_progress" : "todo",
              })
            }
          />
        ) : null}
        {item.status === "done" ? (
          <Button
            label={t("Reopen task")}
            disabled={props.disabled}
            onPress={() =>
              void props.run({
                type: "reopen",
                commandId: commandId(),
                id: item.id,
                expectedVersion: item.version,
              })
            }
          />
        ) : null}
        <Button
          label={t(item.archived ? "Restore task" : "Archive task")}
          disabled={props.disabled || active}
          onPress={() =>
            void props.run({
              type: "archive",
              commandId: commandId(),
              id: item.id,
              expectedVersion: item.version,
              archived: !item.archived,
            })
          }
        />
      </View>
    </>
  );
}

function AgentAssignment(props: {
  readonly environmentId: EnvironmentId;
  readonly item: WorkItem;
  readonly disabled: boolean;
  readonly run: RunCommand;
  readonly onStarted: () => void;
}) {
  const t = useUiTranslation();
  const config = useEnvironmentServerConfig(props.environmentId);
  const options = buildModelOptions(config, null, undefined, props.item.projectId).filter(
    (option) => !option.isUnavailable && !option.isHidden,
  );
  const [modelKey, setModelKey] = useState("");
  const selected = options.find((option) => option.key === modelKey) ?? options[0];
  const [assignment, setAssignment] = useState("");
  const [participants, setParticipants] = useState<
    ReadonlyArray<{
      readonly id: string;
      readonly value: WorkItemParticipant;
    }>
  >([]);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("approval-required");
  const [workspace, setWorkspace] = useState("worktree");
  const [baseRef, setBaseRef] = useState("main");
  const runtimeModes: ReadonlyArray<RuntimeMode> = selected?.supportedRuntimeModes ?? [
    "full-access",
  ];
  const selectedRuntimeMode = runtimeModes.includes(runtimeMode)
    ? runtimeMode
    : (runtimeModes[0] ?? "full-access");
  const add = (selection: ModelSelection) => {
    setParticipants((current) => [
      ...current,
      {
        id: uuidv4(),
        value: {
          assignment: assignment.trim(),
          modelSelection: selection,
          runtimeMode: selectedRuntimeMode,
          interactionMode: "default",
          workspaceStrategy:
            workspace === "worktree"
              ? { type: "worktree", baseRef: baseRef.trim(), startFromOrigin: false }
              : { type: "root" },
        },
      },
    ]);
    setAssignment("");
  };
  const start = async () => {
    const result = await props.run({
      type: "start",
      commandId: commandId(),
      id: props.item.id,
      specRevision: props.item.specRevision,
      participants: participants.map((participant) => participant.value),
    });
    if (result) props.onStarted();
  };
  return (
    <View className="gap-3 rounded-xl bg-subtle p-3">
      <IssuePicker
        label={t("Provider and model")}
        value={selected?.key ?? ""}
        options={options.map((option) => ({
          value: option.key,
          label: `${option.providerLabel} · ${option.label}`,
        }))}
        onChange={setModelKey}
        disabled={props.disabled}
      />
      <Field
        label={t("Assignment")}
        value={assignment}
        onChange={setAssignment}
        multiline
        disabled={props.disabled}
      />
      <IssuePicker
        label={t("Permissions")}
        value={selectedRuntimeMode}
        options={runtimeModes.map((mode) => ({ value: mode, label: t(mode) }))}
        onChange={(value) => {
          const mode = runtimeModes.find((entry) => entry === value);
          if (mode) setRuntimeMode(mode);
        }}
        disabled={props.disabled}
      />
      <IssuePicker
        label={t("Workspace")}
        value={workspace}
        options={[
          { value: "worktree", label: t("New worktree") },
          { value: "root", label: t("Project workspace") },
        ]}
        onChange={setWorkspace}
        disabled={props.disabled}
      />
      {workspace === "worktree" ? (
        <Field
          label={t("Base ref")}
          value={baseRef}
          onChange={setBaseRef}
          disabled={props.disabled}
        />
      ) : null}
      <Button
        label={t("Add agent")}
        disabled={
          props.disabled ||
          !selected ||
          participants.length >= 20 ||
          (workspace === "worktree" && !baseRef.trim())
        }
        onPress={() => {
          if (selected) add(selected.selection);
        }}
      />
      {participants.map((participant, index) => (
        <View key={participant.id} className="gap-2 border-t border-border-subtle py-2">
          <Text>
            {index + 1}. {participant.value.modelSelection.instanceId} ·{" "}
            {participant.value.modelSelection.model}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {participant.value.assignment || t("Complete the task")}
          </Text>
          <Button
            label={t("Remove agent")}
            disabled={props.disabled}
            onPress={() =>
              setParticipants((current) => current.filter((entry) => entry.id !== participant.id))
            }
          />
        </View>
      ))}
      <Button
        label={t("Start agents")}
        tone="primary"
        disabled={props.disabled || participants.length === 0}
        onPress={() => void start()}
      />
    </View>
  );
}

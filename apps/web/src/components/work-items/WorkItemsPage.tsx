import { useAtomValue } from "@effect/atom-react";
import { RequirementDeliveryPanel } from "../requirements/RequirementDeliveryPanel";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ScopedThreadRef,
  type WorkItem,
  type WorkItemSummary,
  type WorkItemCandidate,
  type WorkItemCommandInput,
  type WorkItemExecutionId,
  type WorkItemParticipant,
  type WorkItemSource,
  type WorkItemListInput,
} from "@t3tools/contracts";
import { scopeThreadRef, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  buildWorkItemContinuePrompt,
  selectWorkItemResultIds,
  mergeWorkItemPages,
  prepareWorkItemCommandRetry,
  workItemExecutionIsActive,
  WORK_ITEM_STATUS_LABELS,
} from "@t3tools/client-runtime/work-item";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ArchiveIcon, ArrowLeftIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { randomUUID } from "../../lib/utils";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useEnvironment } from "../../state/environments";
import { useProjects, useQuietThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { formatEnvironmentQueryError } from "../../state/query";
import * as Data from "effect/Data";
import { useEnvironmentQuery } from "../../state/query";
import { AsyncResult, Atom } from "effect/reactivity";
import { useAtomCommand } from "../../state/use-atom-command";
import { useComposerDraftStore } from "../../composerDraftStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { toastManager } from "../ui/toast";

const STATUSES = ["todo", "in_progress", "in_review", "done"] as const;
const commandId = () => CommandId.make(randomUUID());
const textLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

class WorkItemPagesKey extends Data.Class<{
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly cursors: ReadonlyArray<WorkItemListInput["cursor"]>;
  readonly enabled: boolean;
}> {}

const workItemPagesAtom = Atom.family((key: WorkItemPagesKey) =>
  Atom.make((get) => {
    const empty = {
      data: null,
      error: null,
      isPending: false,
      dataUpdatedAt: 0,
      nextCursor: null,
    };
    if (!key.enabled) return empty;
    const results = key.cursors.map((cursor) =>
      get(
        serverEnvironment.workItemsLive({
          environmentId: key.environmentId,
          input: {
            ...(key.projectId ? { projectId: key.projectId } : {}),
            ...(cursor ? { cursor } : {}),
          },
        }),
      ),
    );
    const values = results.map((result) => AsyncResult.getOrElse(result, () => null));
    const items = mergeWorkItemPages(values.flatMap((value) => (value ? [value] : [])));
    const first = values[0];
    const last = values.at(-1);
    const failure = results.find((result) => result._tag === "Failure");
    return {
      data: first ? { items, candidates: first.candidates } : null,
      error: failure ? formatEnvironmentQueryError(failure.cause) : null,
      isPending: results.some((result) => result.waiting),
      dataUpdatedAt: Math.max(
        0,
        ...results.map((result) => (result._tag === "Success" ? result.timestamp : 0)),
      ),
      nextCursor: last?.nextCursor ?? null,
    };
  }),
);

function WorkItemSelect(props: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={props.value}
      items={props.options}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value !== null) props.onChange(value);
      }}
    >
      <SelectTrigger size="sm" aria-label={props.label}>
        <SelectValue placeholder={props.label} />
      </SelectTrigger>
      <SelectPopup>
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function ThreadWorkItemsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useQuietThreadShell(threadRef);
  return thread ? (
    <WorkItemsBoard
      environmentId={threadRef.environmentId}
      key={`${threadRef.environmentId}:${thread.projectId}`}
      initialProjectId={thread.projectId}
      threadRef={threadRef}
      compact
    />
  ) : null;
}

export function WorkItemsBoard({
  environmentId,
  initialProjectId,
  threadRef,
  compact = false,
  localOnly = false,
}: {
  environmentId: EnvironmentId;
  initialProjectId?: ProjectId | undefined;
  threadRef?: ScopedThreadRef | undefined;
  compact?: boolean;
  localOnly?: boolean;
}) {
  const t = useUiTranslation();
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.archivedAt === null,
  );
  const [chosenProject, setChosenProject] = useState(initialProjectId);
  const projectId = chosenProject ?? projects[0]?.id;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.workItems === true;
  const pageKey = `${environmentId}:${projectId ?? ""}`;
  const [pagination, setPagination] = useState<{
    key: string;
    cursors: ReadonlyArray<WorkItemListInput["cursor"]>;
  }>({ key: pageKey, cursors: [undefined] });
  if (pagination.key !== pageKey) setPagination({ key: pageKey, cursors: [undefined] });
  const query = useAtomValue(
    workItemPagesAtom(
      new WorkItemPagesKey({
        environmentId,
        projectId: projectId ?? null,
        cursors: pagination.cursors,
        enabled: supported && pagination.key === pageKey,
      }),
    ),
  );
  const environment = useEnvironment(environmentId);
  const permitted = useAtomValue(serverEnvironment.mutateWorkItem.permissionAtom(environmentId));
  const canOperate = permitted && environment?.connection.phase === "connected";
  const mutate = useAtomCommand(serverEnvironment.mutateWorkItem, { reportFailure: false });
  const discover = useAtomCommand(serverEnvironment.discoverWorkItems, { reportFailure: false });
  const [draggedItem, setDraggedItem] = useState<WorkItemSummary | null>(null);
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<WorkItem["id"] | null>(null);
  const [editor, setEditor] = useState<{ item?: WorkItem; candidate?: WorkItemCandidate } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const retryCommands = useRef(new Map<string, CommandId>());
  const navigate = useNavigate();
  const openNewThread = useNewThreadHandler();
  const selectedQuery = useEnvironmentQuery(
    supported && selectedId
      ? serverEnvironment.workItemsLive({ environmentId, input: { id: selectedId } })
      : null,
  );
  const selected = selectedQuery.data?.item;
  const filtered = (query.data?.items ?? []).filter(
    (item) =>
      item.archived === archived &&
      (!localOnly || item.issue === undefined) &&
      `${item.title}\n${item.description}`.toLowerCase().includes(search.toLowerCase()),
  );
  const run = async (input: WorkItemCommandInput, intent?: string) => {
    if (pending.current || !canOperate || !supported) return false;
    const request = prepareWorkItemCommandRetry(input, retryCommands.current, intent);
    pending.current = true;
    setBusy(true);
    const result = await mutate({ environmentId, input: request.input }).finally(() => {
      pending.current = false;
      setBusy(false);
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        toastManager.add({
          type: "error",
          title: t("Could not update task"),
          description: String(squashAtomCommandFailure(result)),
        });
      return false;
    }
    retryCommands.current.delete(request.key);
    return true;
  };
  const discoverTasks = async (dismissThreadId?: WorkItemCandidate["id"]) => {
    if (!projectId || pending.current || !canOperate) return;
    pending.current = true;
    setBusy(true);
    const result = await discover({
      environmentId,
      input: { projectId, ...(dismissThreadId ? { dismissThreadId } : {}) },
    }).finally(() => {
      pending.current = false;
      setBusy(false);
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      toastManager.add({
        type: "error",
        title: t("Could not discover tasks"),
        description: String(squashAtomCommandFailure(result)),
      });
  };
  const continueTask = async (item: WorkItem, newConversation = false) => {
    const sourceThreadId =
      item.sources[0]?.threadId ?? item.executions.at(-1)?.threadId ?? threadRef?.threadId;
    const opened =
      newConversation || !sourceThreadId
        ? await openNewThread(scopeProjectRef(environmentId, item.projectId))
        : null;
    if ((newConversation || !sourceThreadId) && !opened) return;
    const target =
      opened?.draftId ?? (sourceThreadId ? scopeThreadRef(environmentId, sourceThreadId) : null);
    if (!target) return;
    const drafts = useComposerDraftStore.getState();
    const previous = drafts.getComposerDraft(target)?.prompt ?? "";
    drafts.setPrompt(
      target,
      [previous, buildWorkItemContinuePrompt(item)].filter(Boolean).join("\n\n"),
    );
    if (!opened && sourceThreadId)
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: sourceThreadId },
      });
  };
  if (!supported)
    return (
      <div className="p-5 text-sm text-muted-foreground">
        {t("Update this environment to use the task board.")}
      </div>
    );
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden" data-task-board>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-3">
        {selectedId ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("Back to tasks")}
            onClick={() => setSelectedId(null)}
          >
            <ArrowLeftIcon />
            {t("Back")}
          </Button>
        ) : null}
        <div className="min-w-36 flex-1">
          <WorkItemSelect
            label={t("Project")}
            value={projectId ?? ""}
            options={projects.map((project) => ({ value: project.id, label: project.title }))}
            onChange={(value) => {
              const project = projects.find((entry) => entry.id === value);
              if (project) {
                setChosenProject(project.id);
                setSelectedId(null);
              }
            }}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!projectId || !canOperate || busy || config?.workItemDiscovery !== true}
          onClick={() => void discoverTasks()}
        >
          <SearchIcon />
          {t("Discover")}
        </Button>
        <Button
          size="sm"
          disabled={!projectId || !canOperate || busy}
          onClick={() => setEditor({})}
        >
          <PlusIcon />
          {t("New task")}
        </Button>
      </div>
      {query.dataUpdatedAt > 0 ? (
        <p className="px-3 pt-2 text-xs text-muted-foreground">
          {t("Last synchronized: {time}", {
            time: new Date(query.dataUpdatedAt).toLocaleTimeString(),
          })}
        </p>
      ) : null}
      {query.error ? (
        <p role="alert" className="border-b border-border p-3 text-sm text-destructive">
          {query.error}
        </p>
      ) : null}
      {query.isPending && !query.data ? (
        <p className="p-4 text-sm text-muted-foreground">{t("Loading tasks…")}</p>
      ) : null}
      {selected ? (
        <WorkItemDetails
          key={selected.id}
          item={selected}
          deliverySummary={selectedQuery.data?.items[0]?.deliverySummary}
          environmentId={environmentId}
          busy={busy}
          canOperate={canOperate}
          run={run}
          edit={() => setEditor({ item: selected })}
          continueTask={(newConversation) => void continueTask(selected, newConversation)}
        />
      ) : selectedId ? (
        <p className="p-4 text-sm text-muted-foreground">
          {selectedQuery.error ?? t("Loading task…")}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="min-w-36 flex-1">
              <Input
                aria-label={t("Search tasks")}
                placeholder={t("Search tasks")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={archived} onCheckedChange={setArchived} />
              {t("Archived")}
            </label>
          </div>
          <div className={compact ? "space-y-4" : "grid gap-4 md:grid-cols-2 xl:grid-cols-4"}>
            {STATUSES.map((status) => (
              <section
                key={status}
                className="min-w-0 rounded-xl border border-border bg-muted/20 p-3"
                aria-label={t(WORK_ITEM_STATUS_LABELS[status])}
                onDragOver={(event) => {
                  if (
                    draggedItem &&
                    (status === "todo" || status === "in_progress") &&
                    draggedItem.status !== status
                  )
                    event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const item = draggedItem;
                  setDraggedItem(null);
                  if (
                    item &&
                    (status === "todo" || status === "in_progress") &&
                    item.status !== status
                  )
                    void run({
                      type: "move",
                      commandId: commandId(),
                      id: item.id,
                      expectedVersion: item.version,
                      status,
                    });
                }}
              >
                <h2 className="mb-3 flex items-center justify-between text-sm font-medium">
                  {t(WORK_ITEM_STATUS_LABELS[status])}
                  <span className="text-muted-foreground">
                    {filtered.filter((item) => item.status === status).length}
                  </span>
                </h2>
                <div className="space-y-2">
                  {filtered
                    .filter((item) => item.status === status)
                    .map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedId(item.id)}
                        draggable={
                          canOperate &&
                          !busy &&
                          !item.archived &&
                          (item.status === "todo" || item.status === "in_progress")
                        }
                        onDragStart={() => setDraggedItem(item)}
                        onDragEnd={() => setDraggedItem(null)}
                        className="w-full rounded-lg border border-border bg-background p-3 text-left shadow-xs outline-none transition-colors hover:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <span className="mb-2 flex items-start gap-2">
                          <span className="min-w-0 flex-1 break-words text-sm font-medium">
                            {item.title}
                          </span>
                          <span className="text-xs text-muted-foreground">{item.priority}</span>
                        </span>
                        {item.description ? (
                          <span className="mb-3 block line-clamp-2 text-xs text-muted-foreground">
                            {item.description}
                          </span>
                        ) : null}
                        <span className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                          <span>{t("{count} agents", { count: item.executionCount })}</span>
                          {item.activeExecutionCount > 0 ? <span>{t("Running")}</span> : null}
                        </span>
                      </button>
                    ))}
                </div>
              </section>
            ))}
          </div>
          {query.nextCursor ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={query.isPending}
                onClick={() => {
                  const cursor = query.nextCursor;
                  if (cursor)
                    setPagination((previous) => ({
                      ...previous,
                      cursors: [...previous.cursors, cursor],
                    }));
                }}
              >
                {t("Load more tasks")}
              </Button>
            </div>
          ) : null}
          {filtered.length === 0 && query.data ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("No tasks yet. Create a task or discover work from conversations.")}
            </p>
          ) : null}
          {(query.data?.candidates.length ?? 0) > 0 ? (
            <section className="mt-6 space-y-2">
              <h2 className="text-sm font-medium">{t("Discovered conversations")}</h2>
              <p className="text-xs text-muted-foreground">
                {t("Suggestions do not start agents or change existing tasks.")}
              </p>
              {query.data?.candidates.map((candidate) => (
                <div
                  key={candidate.id}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{candidate.title}</p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {candidate.description}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canOperate || busy}
                    onClick={() => setEditor({ candidate })}
                  >
                    {t("Add task")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canOperate || busy}
                    onClick={() => void discoverTasks(candidate.id)}
                  >
                    {t("Ignore")}
                  </Button>
                </div>
              ))}
            </section>
          ) : null}
        </div>
      )}
      {editor && projectId ? (
        <WorkItemEditor
          key={editor.item?.id ?? editor.candidate?.id ?? "new"}
          original={editor.item}
          candidate={editor.candidate}
          threadRef={threadRef}
          projectId={projectId}
          busy={busy}
          run={run}
          close={() => setEditor(null)}
        />
      ) : null}
    </section>
  );
}

export function WorkItemEditor({
  initialTitle,
  initialDescription,
  initialSources,
  original,
  candidate,
  projectId,
  threadRef,
  busy,
  run,
  close,
}: {
  initialTitle?: string | undefined;
  initialDescription?: string | undefined;
  initialSources?: ReadonlyArray<WorkItemSource> | undefined;
  original?: WorkItem | undefined;
  candidate?: WorkItemCandidate | undefined;
  projectId: ProjectId;
  threadRef?: ScopedThreadRef | undefined;
  busy: boolean;
  run: (input: WorkItemCommandInput, intent?: string) => Promise<boolean>;
  close: () => void;
}) {
  const t = useUiTranslation();
  const thread = useQuietThreadShell(threadRef ?? null);
  const [title, setTitle] = useState(original?.title ?? candidate?.title ?? initialTitle ?? "");
  const [description, setDescription] = useState(
    original?.description ?? candidate?.description ?? initialDescription ?? "",
  );
  const [constraints, setConstraints] = useState(original?.constraints.join("\n") ?? "");
  const [criteria, setCriteria] = useState(original?.acceptanceCriteria.join("\n") ?? "");
  const [priority, setPriority] = useState<WorkItem["priority"]>(original?.priority ?? "P2");
  const intent = useRef(randomUUID());
  const save = async () => {
    const sources: ReadonlyArray<WorkItemSource> =
      original?.sources ??
      initialSources ??
      (candidate
        ? [{ threadId: candidate.id, title: candidate.title }]
        : threadRef && thread?.projectId === projectId
          ? [{ threadId: threadRef.threadId, title: thread.title }]
          : []);
    const fields = {
      commandId: commandId(),
      title: title.trim(),
      description,
      constraints: textLines(constraints),
      acceptanceCriteria: textLines(criteria),
      priority,
      sources,
    };
    const ok = await run(
      original
        ? { type: "update", ...fields, id: original.id, expectedVersion: original.version }
        : { type: "create", ...fields, projectId },
      intent.current,
    );
    if (ok) close();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t(original ? "Edit task" : "New task")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="work-item-title">{t("Title")}</Label>
              <Input
                id="work-item-title"
                value={title}
                maxLength={300}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="work-item-description">{t("Goal")}</Label>
              <Textarea
                id="work-item-description"
                value={description}
                maxLength={16000}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="work-item-constraints">{t("Constraints, one per line")}</Label>
              <Textarea
                id="work-item-constraints"
                value={constraints}
                onChange={(event) => setConstraints(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="work-item-criteria">{t("Acceptance criteria, one per line")}</Label>
              <Textarea
                id="work-item-criteria"
                value={criteria}
                onChange={(event) => setCriteria(event.target.value)}
              />
            </div>
            <WorkItemSelect
              label={t("Priority")}
              value={priority}
              options={["P0", "P1", "P2", "P3"].map((value) => ({ value, label: value }))}
              onChange={(value) => {
                if (value === "P0" || value === "P1" || value === "P2" || value === "P3")
                  setPriority(value);
              }}
            />
            {original?.executions.some(workItemExecutionIsActive) ? (
              <p className="text-xs text-muted-foreground">
                {t(
                  "Changes apply to future executions. Running agents keep their original specification.",
                )}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>
            {t("Cancel")}
          </Button>
          <Button disabled={busy || !title.trim()} onClick={() => void save()}>
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function WorkItemDetails({
  item,
  deliverySummary,
  environmentId,
  busy,
  canOperate,
  run,
  edit,
  continueTask,
}: {
  item: WorkItem;
  deliverySummary: WorkItemSummary["deliverySummary"];
  environmentId: EnvironmentId;
  busy: boolean;
  canOperate: boolean;
  run: (input: WorkItemCommandInput, intent?: string) => Promise<boolean>;
  edit: () => void;
  continueTask: (newConversation?: boolean) => void;
}) {
  const t = useUiTranslation();
  const navigate = useNavigate();
  const [assigning, setAssigning] = useState(false);
  const [selectedExecutions, setSelectedExecutions] = useState<ReadonlyArray<WorkItemExecutionId>>(
    [],
  );
  const [summary, setSummary] = useState("");
  const [artifacts, setArtifacts] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const active = item.executions.some(workItemExecutionIsActive);
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 break-words text-lg font-semibold">{item.title}</h2>
        <Badge variant="secondary">{t(WORK_ITEM_STATUS_LABELS[item.status])}</Badge>
        <Badge variant="outline">v{item.specRevision}</Badge>
      </div>
      {item.delivery ? (
        <RequirementDeliveryPanel
          environmentId={environmentId}
          item={item}
          summary={deliverySummary}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!canOperate || busy} onClick={edit}>
          {t("Edit")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => continueTask()}>
          {t("Continue in conversation")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => continueTask(true)}>
          {t("New conversation draft")}
        </Button>
        <Button
          size="sm"
          disabled={!canOperate || busy || item.archived || item.status === "done"}
          onClick={() => setAssigning(true)}
        >
          <PlusIcon />
          {t("Assign agents")}
        </Button>
        {active ? (
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={!canOperate || busy}
            onClick={() => void run({ type: "stop", commandId: commandId(), id: item.id })}
          >
            {t("Stop all agents")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={!canOperate || busy || active}
          onClick={() =>
            void run({
              type: "archive",
              commandId: commandId(),
              id: item.id,
              expectedVersion: item.version,
              archived: !item.archived,
            })
          }
        >
          <ArchiveIcon />
          {t(item.archived ? "Restore" : "Archive")}
        </Button>
        {item.status === "done" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!canOperate || busy}
            onClick={() =>
              void run({
                type: "reopen",
                commandId: commandId(),
                id: item.id,
                expectedVersion: item.version,
              })
            }
          >
            {t("Reopen")}
          </Button>
        ) : null}
      </div>
      {(item.status === "todo" || item.status === "in_progress") && !item.archived ? (
        <div className="flex flex-wrap gap-2">
          {item.status === "todo" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!canOperate || busy}
              onClick={() =>
                void run({
                  type: "move",
                  commandId: commandId(),
                  id: item.id,
                  expectedVersion: item.version,
                  status: "in_progress",
                })
              }
            >
              {t("Mark in progress")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!canOperate || busy || active}
              onClick={() =>
                void run({
                  type: "move",
                  commandId: commandId(),
                  id: item.id,
                  expectedVersion: item.version,
                  status: "todo",
                })
              }
            >
              {t("Move to to do")}
            </Button>
          )}
        </div>
      ) : null}
      <p className="whitespace-pre-wrap text-sm">{item.description}</p>
      {item.constraints.length ? (
        <div>
          <h3 className="mb-2 text-sm font-medium">{t("Constraints")}</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {[...new Set(item.constraints)].map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {item.acceptanceCriteria.length ? (
        <div>
          <h3 className="mb-2 text-sm font-medium">{t("Acceptance criteria")}</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {[...new Set(item.acceptanceCriteria)].map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {item.reviewFeedback ? (
        <section className="space-y-2 rounded-lg border border-border p-3">
          <h3 className="text-sm font-medium">{t("Review notes")}</h3>
          <p className="whitespace-pre-wrap text-sm">{item.reviewFeedback}</p>
        </section>
      ) : null}
      {item.sources.length ? (
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{t("Sources")}</h3>
          {item.sources.map((source) => (
            <div key={`${source.threadId}:${source.messageId ?? ""}`}>
              <Button
                size="sm"
                variant="link"
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId: source.threadId },
                  })
                }
              >
                {source.title}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t("Agent executions")}</h3>
        {item.executions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("No agent has been assigned.")}</p>
        ) : null}
        {item.executions.map((execution) => (
          <article key={execution.id} className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 break-words text-sm font-medium">
                {execution.modelSelection.model}
              </span>
              <Badge variant="outline">{t(execution.status)}</Badge>
              <span className="text-xs text-muted-foreground">v{execution.specRevision}</span>
            </div>
            <p className="text-xs text-muted-foreground">{execution.modelSelection.instanceId}</p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">{t("Workspace path")}</dt>
              <dd className="min-w-0 break-all">
                <code>{execution.resolvedWorkspacePath ?? t("Not available")}</code>
              </dd>
              <dt className="text-muted-foreground">{t("Branch")}</dt>
              <dd className="min-w-0 break-all">
                <code>{execution.branch ?? t("Not available")}</code>
              </dd>
              <dt className="text-muted-foreground">{t("Checkpoint reference")}</dt>
              <dd className="min-w-0 break-all">
                <code>
                  {execution.checkpointRef ?? execution.checkpointId ?? t("Not available")}
                </code>
              </dd>
              {execution.codeEvidenceCapturedAt ? (
                <>
                  <dt className="text-muted-foreground">{t("Evidence captured")}</dt>
                  <dd>{new Date(execution.codeEvidenceCapturedAt).toLocaleString()}</dd>
                </>
              ) : null}
            </dl>
            <p className="whitespace-pre-wrap text-sm">{execution.assignment}</p>
            {execution.specRevision !== item.specRevision ? (
              <p className="text-xs text-warning-foreground">
                {t("This result belongs to an older specification.")}
              </p>
            ) : null}
            {execution.summary ? (
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {execution.summary}
              </p>
            ) : null}
            {execution.error ? (
              <p role="alert" className="text-sm text-destructive">
                {execution.error}
              </p>
            ) : null}
            {[...new Set(execution.artifacts)].map((artifact) => (
              <p key={artifact} className="break-all text-xs text-muted-foreground">
                {artifact}
              </p>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId: execution.threadId },
                  })
                }
              >
                {t("Open conversation")}
              </Button>
              {workItemExecutionIsActive(execution) ? (
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={!canOperate || busy || execution.stopRequested}
                  onClick={() =>
                    void run({
                      type: "stop",
                      commandId: commandId(),
                      id: item.id,
                      executionId: execution.id,
                    })
                  }
                >
                  {t(execution.stopRequested ? "Stopping…" : "Stop agent")}
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canOperate || busy || item.archived || item.status === "done"}
                    onClick={() =>
                      void run({
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
                  >
                    {t("Retry agent")}
                  </Button>
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox
                      disabled={
                        execution.status !== "completed" ||
                        execution.specRevision !== item.specRevision ||
                        !canOperate ||
                        busy
                      }
                      checked={selectedExecutions.includes(execution.id)}
                      onCheckedChange={(checked) =>
                        setSelectedExecutions((previous) =>
                          checked
                            ? [...previous, execution.id]
                            : previous.filter((id) => id !== execution.id),
                        )
                      }
                    />
                    {t("Use this result")}
                  </label>
                </>
              )}
            </div>
          </article>
        ))}
      </section>
      {item.status !== "done" && !item.archived && !item.delivery ? (
        <section className="space-y-3 rounded-lg border border-border p-3">
          <h3 className="text-sm font-medium">{t("Submit for acceptance")}</h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "Select results and describe the integrated deliverable. Running agents must finish or be stopped first.",
            )}
          </p>
          <Textarea
            aria-label={t("Delivery summary")}
            placeholder={t("Delivery summary")}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
          <Textarea
            aria-label={t("Artifacts, one per line")}
            placeholder={t("Artifacts, one per line")}
            value={artifacts}
            onChange={(event) => setArtifacts(event.target.value)}
          />
          <Button
            size="sm"
            disabled={!canOperate || busy || active || !summary.trim()}
            onClick={() =>
              void run({
                type: "submit",
                commandId: commandId(),
                id: item.id,
                expectedVersion: item.version,
                specRevision: item.specRevision,
                executionIds: selectWorkItemResultIds(item, selectedExecutions),
                summary,
                artifacts: textLines(artifacts),
              })
            }
          >
            {t("Submit for acceptance")}
          </Button>
        </section>
      ) : null}
      {item.submission ? (
        <section className="space-y-3 rounded-lg border border-border p-3">
          <h3 className="text-sm font-medium">{t("Delivery")}</h3>
          <p className="whitespace-pre-wrap text-sm">{item.submission.summary}</p>
          {item.submission.executionEvidence?.length ? (
            <div className="space-y-3">
              <h4 className="text-xs font-medium">{t("Selected execution evidence")}</h4>
              <p className="text-xs text-muted-foreground">
                {t(
                  "These references were recorded at submission. Verify the integrated deliverable separately.",
                )}
              </p>
              {item.submission.executionEvidence.map((evidence) => (
                <div
                  key={evidence.executionId}
                  className="space-y-2 rounded-md border border-border p-2"
                >
                  <p className="break-all text-xs text-muted-foreground">
                    {evidence.executionId} · v{evidence.specRevision}
                  </p>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">{t("Workspace path")}</dt>
                    <dd className="min-w-0 break-all">
                      <code>{evidence.workspacePath ?? t("Not available")}</code>
                    </dd>
                    <dt className="text-muted-foreground">{t("Branch")}</dt>
                    <dd className="min-w-0 break-all">
                      <code>{evidence.branch ?? t("Not available")}</code>
                    </dd>
                    <dt className="text-muted-foreground">{t("Checkpoint reference")}</dt>
                    <dd className="min-w-0 break-all">
                      <code>
                        {evidence.checkpointRef ?? evidence.checkpointId ?? t("Not available")}
                      </code>
                    </dd>
                    <dt className="text-muted-foreground">{t("Evidence captured")}</dt>
                    <dd>{new Date(evidence.capturedAt).toLocaleString()}</dd>
                  </dl>
                  <Button
                    size="sm"
                    variant="link"
                    onClick={() =>
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: { environmentId, threadId: evidence.threadId },
                      })
                    }
                  >
                    {t("Open conversation")}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          {[...new Set(item.submission.artifacts)].map((artifact) => (
            <p key={artifact} className="break-all text-xs text-muted-foreground">
              {artifact}
            </p>
          ))}
          {item.status === "in_review" ? (
            <>
              <Textarea
                aria-label={t("Review note")}
                placeholder={t("Review note")}
                value={reviewNote}
                onChange={(event) => setReviewNote(event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={
                    !canOperate ||
                    busy ||
                    active ||
                    item.submission.specRevision !== item.specRevision
                  }
                  onClick={() =>
                    void run({
                      type: "review",
                      commandId: commandId(),
                      id: item.id,
                      expectedVersion: item.version,
                      decision: "accept",
                      note: reviewNote,
                    })
                  }
                >
                  {t("Accept and complete")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canOperate || busy}
                  onClick={() =>
                    void run({
                      type: "review",
                      commandId: commandId(),
                      id: item.id,
                      expectedVersion: item.version,
                      decision: "changes",
                      note: reviewNote,
                    })
                  }
                >
                  {t("Request changes")}
                </Button>
              </div>
            </>
          ) : null}
        </section>
      ) : null}
      {assigning ? (
        <AssignAgentsDialog
          environmentId={environmentId}
          item={item}
          busy={busy}
          run={run}
          close={() => setAssigning(false)}
        />
      ) : null}
    </div>
  );
}

function AssignAgentsDialog({
  environmentId,
  item,
  busy,
  run,
  close,
}: {
  environmentId: EnvironmentId;
  item: WorkItem;
  busy: boolean;
  run: (input: WorkItemCommandInput, intent?: string) => Promise<boolean>;
  close: () => void;
}) {
  const t = useUiTranslation();
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  const options = providers
    .filter(
      (provider) =>
        provider.enabled && provider.installed && provider.availability !== "unavailable",
    )
    .flatMap((provider) =>
      provider.models.map((model) => ({
        value: `${provider.instanceId}\n${model.slug}`,
        label: `${provider.displayName ?? provider.driver} · ${model.name}`,
        selection: { instanceId: provider.instanceId, model: model.slug } satisfies ModelSelection,
      })),
    );
  const [rows, setRows] = useState<
    ReadonlyArray<{ key: string; modelKey: string; assignment: string }>
  >([{ key: randomUUID(), modelKey: options[0]?.value ?? "", assignment: "" }]);
  const intent = useRef(randomUUID());
  const [isolated, setIsolated] = useState(true);
  const [baseRef, setBaseRef] = useState("main");
  const [runtimeMode, setRuntimeMode] =
    useState<WorkItemParticipant["runtimeMode"]>("approval-required");
  const start = async () => {
    const participants: Array<WorkItemParticipant> = [];
    for (const row of rows) {
      const model = options.find((option) => option.value === row.modelKey);
      if (!model) return;
      participants.push({
        assignment: row.assignment,
        modelSelection: model.selection,
        runtimeMode,
        interactionMode: "default",
        workspaceStrategy: isolated
          ? { type: "worktree", baseRef: baseRef.trim() }
          : { type: "root" },
      });
    }
    if (
      await run(
        {
          type: "start",
          commandId: commandId(),
          id: item.id,
          specRevision: item.specRevision,
          participants,
        },
        intent.current,
      )
    )
      close();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("Assign agents")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t(
                "Each agent gets an independent conversation and execution. Results remain separate until you select or integrate them.",
              )}
            </p>
            {rows.map((row) => (
              <div key={row.key} className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <WorkItemSelect
                      label={t("Agent model")}
                      value={row.modelKey}
                      options={options}
                      onChange={(modelKey) =>
                        setRows((previous) =>
                          previous.map((entry) =>
                            entry.key === row.key ? { ...entry, modelKey } : entry,
                          ),
                        )
                      }
                    />
                  </div>
                  {rows.length > 1 ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("Remove agent")}
                      onClick={() =>
                        setRows((previous) => previous.filter((entry) => entry.key !== row.key))
                      }
                    >
                      <XIcon />
                    </Button>
                  ) : null}
                </div>
                <Textarea
                  aria-label={t("Assignment")}
                  placeholder={t("Assignment and scope for this agent")}
                  value={row.assignment}
                  onChange={(event) =>
                    setRows((previous) =>
                      previous.map((entry) =>
                        entry.key === row.key
                          ? { ...entry, assignment: event.target.value }
                          : entry,
                      ),
                    )
                  }
                />
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              disabled={rows.length >= 20}
              onClick={() =>
                setRows((previous) => [
                  ...previous,
                  { key: randomUUID(), modelKey: options[0]?.value ?? "", assignment: "" },
                ])
              }
            >
              <PlusIcon />
              {t("Add agent")}
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={isolated} onCheckedChange={setIsolated} />
              {t("Independent worktree for each agent")}
            </label>
            {isolated ? (
              <Input
                aria-label={t("Base ref")}
                value={baseRef}
                onChange={(event) => setBaseRef(event.target.value)}
              />
            ) : null}
            <WorkItemSelect
              label={t("Permissions")}
              value={runtimeMode}
              options={[
                { value: "approval-required", label: t("Ask for approval") },
                { value: "full-access", label: t("Full access") },
              ]}
              onChange={(value) => {
                if (value === "approval-required" || value === "full-access") setRuntimeMode(value);
              }}
            />
            {options.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("Configure an available provider before assigning agents.")}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={
              busy ||
              options.length === 0 ||
              rows.some((row) => !options.some((option) => option.value === row.modelKey)) ||
              (isolated && !baseRef.trim())
            }
            onClick={() => void start()}
          >
            {t("Start agents")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

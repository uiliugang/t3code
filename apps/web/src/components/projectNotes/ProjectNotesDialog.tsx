import { BookOpenIcon, PlusIcon } from "lucide-react";
import { useRef, useState } from "react";
import type {
  DesktopProjectNotesCall,
  DesktopProjectNotesOutcome,
  EnvironmentId,
  ProjectId,
  ProjectNote,
  ProjectNoteId,
  ProjectNotePage,
} from "@t3tools/contracts";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { randomUUID } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { noteMutationUnconfirmed } from "./projectNoteMutation";
import { ProjectNoteEditor } from "./ProjectNoteEditor";
import {
  beginNoteSave,
  confirmNoteSave,
  isDirtyNoteDraft,
  noteSaveConflicted,
  openSavedNote,
  resolveNoteConflict,
  type NoteDraft,
  type NoteSaveSnapshot,
} from "./projectNoteDraft";
import { confirmProjectNoteDrafts, type ConfirmedProjectNoteDrafts } from "./projectNoteDraftVault";

export type ProjectNotesSelection = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly initialPage: ProjectNotePage | null;
  readonly initialDraft: NoteDraft | null;
  readonly drafts: ConfirmedProjectNoteDrafts;
};
export async function localNotesEnvironment(): Promise<EnvironmentId | null> {
  return (await window.desktopBridge?.getProjectNotesEnvironment?.().catch(() => null)) ?? null;
}
async function requestNote(
  environmentId: EnvironmentId,
  call: DesktopProjectNotesCall,
): Promise<DesktopProjectNotesOutcome> {
  const unavailable = { ok: false, failure: { reason: "unavailable" } } as const;
  return (
    (await window.desktopBridge
      ?.callProjectNotes?.({ environmentId, call })
      .catch(() => unavailable)) ?? unavailable
  );
}
async function loadProjectNotesPage(environmentId: EnvironmentId, projectId: ProjectId) {
  const outcome = await requestNote(environmentId, {
    _tag: "list",
    input: { projectId, archived: false, limit: 50 },
  });
  return outcome.ok && outcome.result._tag === "list" ? outcome.result.value : null;
}
export async function prepareProjectNotesSelection(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  title: string,
): Promise<ProjectNotesSelection | null> {
  const bridge = window.desktopBridge;
  if (!bridge) return null;
  const drafts = await confirmProjectNoteDrafts(bridge, environmentId, projectId);
  if (!drafts || window.desktopBridge !== bridge) return null;
  const page = await loadProjectNotesPage(environmentId, projectId);
  const restored = page
    ? await drafts.restorePending(async (id) => {
        const saved = await requestNote(environmentId, { _tag: "get", input: { projectId, id } });
        return saved.ok && saved.result._tag === "get" ? saved.result.value : null;
      })
    : { available: false as const };
  if (window.desktopBridge !== bridge || (await localNotesEnvironment()) !== environmentId)
    return null;
  return {
    environmentId,
    projectId,
    title,
    // A different note must not replace a cached draft that could not be restored.
    initialPage: restored.available ? page : null,
    initialDraft: restored.available ? restored.draft : null,
    drafts,
  };
}
export function ProjectNotesDialog({
  project,
  onClose,
}: {
  readonly project: ProjectNotesSelection;
  readonly onClose: () => void;
}) {
  const t = useUiTranslation();
  const { environmentId, projectId } = project;
  const [page, setPage] = useState(project.initialPage);
  const [draft, setDraft] = useState(project.initialDraft);
  const latestDraft = useRef(project.initialDraft);
  const [comparison, setComparison] = useState<ProjectNote | null>(null);
  const [working, setWorking] = useState(false);
  const pendingCreate = useRef<Extract<DesktopProjectNotesCall, { _tag: "create" }> | null>(null);
  const [pendingSave, setPendingSave] = useState<NoteSaveSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [discard, setDiscard] = useState(false);
  const dirty = pendingSave !== null || (draft !== null && isDirtyNoteDraft(draft));
  const changeDraft = (modify: (current: NoteDraft | null) => NoteDraft | null) => {
    const updated = modify(latestDraft.current);
    latestDraft.current = updated;
    project.drafts.retain(updated);
    setDraft(updated);
  };
  const updateList = async () => {
    const result = await loadProjectNotesPage(environmentId, projectId);
    if (result) setPage(result);
    else setError(true);
  };
  const loadMore = async () => {
    if (working || page?.nextCursor == null) return;
    setWorking(true);
    setError(false);
    const outcome = await requestNote(environmentId, {
      _tag: "list",
      input: { projectId, archived: false, limit: 50, cursor: page.nextCursor },
    });
    if (outcome.ok && outcome.result._tag === "list") {
      const next = outcome.result.value;
      const present = new Set(page.notes.map((note) => note.id));
      setPage({
        notes: [...page.notes, ...next.notes.filter((note) => !present.has(note.id))],
        nextCursor: next.nextCursor,
      });
    } else setError(true);
    setWorking(false);
  };
  const read = async (id: ProjectNoteId) => {
    const outcome = await requestNote(environmentId, { _tag: "get", input: { projectId, id } });
    if (outcome.ok && outcome.result._tag === "get") {
      const saved = outcome.result.value;
      changeDraft((current) => openSavedNote(current, { ...saved, clientScopeKey: environmentId }));
    } else setError(true);
  };
  const choose = async (id: ProjectNoteId) => {
    if (working || dirty) return;
    setWorking(true);
    setComparison(null);
    setDiscard(false);
    setError(false);
    await read(id);
    setWorking(false);
  };
  const create = async () => {
    if (working || dirty) return;
    setWorking(true);
    setError(false);
    const request = pendingCreate.current ?? {
      _tag: "create",
      input: { projectId, title: t("Untitled note"), markdown: "", mutationId: randomUUID() },
    };
    const outcome = await requestNote(environmentId, request);
    pendingCreate.current = noteMutationUnconfirmed(outcome, "create") ? request : null;
    if (outcome.ok && outcome.result._tag === "create") {
      const { title, markdown } = request.input;
      const created = outcome.result.value;
      changeDraft((current) =>
        openSavedNote(current, {
          ...created,
          projectId,
          clientScopeKey: environmentId,
          title,
          markdown,
        }),
      );
      await updateList();
    } else setError(true);
    setWorking(false);
  };
  const save = async () => {
    if (working || draft === null) return;
    const snapshot = beginNoteSave(draft, randomUUID, pendingSave);
    if (!snapshot) return;
    const { id, title, markdown, expectedRevision, mutationId } = snapshot;
    setWorking(true);
    setError(false);
    const outcome = await requestNote(environmentId, {
      _tag: "update",
      input: { projectId, id, title, markdown, expectedRevision, mutationId },
    });
    setPendingSave(noteMutationUnconfirmed(outcome, "update") ? snapshot : null);
    if (outcome.ok && outcome.result._tag === "update") {
      const value = outcome.result.value;
      changeDraft((current) => (current ? confirmNoteSave(current, snapshot, value) : current));
      await updateList();
    } else if (
      !outcome.ok &&
      outcome.failure.reason === "conflict" &&
      outcome.failure.currentRevision !== undefined
    ) {
      const revision = outcome.failure.currentRevision;
      changeDraft((current) =>
        current ? noteSaveConflicted(current, snapshot, revision) : current,
      );
    } else setError(true);
    setWorking(false);
  };
  const showComparison = async () => {
    if (working || draft?.conflictingRevision == null) return;
    setWorking(true);
    setError(false);
    const outcome = await requestNote(environmentId, {
      _tag: "get",
      input: { projectId, id: draft.id },
    });
    if (outcome.ok && outcome.result._tag === "get") setComparison(outcome.result.value);
    else setError(true);
    setWorking(false);
  };
  const resolveComparison = (useSaved: boolean) => {
    if (!comparison || !draft || working) return;
    changeDraft(() =>
      resolveNoteConflict(
        draft,
        { ...comparison, clientScopeKey: environmentId },
        useSaved
          ? { title: comparison.title, markdown: comparison.markdown }
          : { title: draft.title, markdown: draft.markdown },
      ),
    );
    setComparison(null);
  };
  const close = () => {
    if (working) return;
    if (dirty) setDiscard(true);
    else onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="max-h-[85dvh] max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("Project notes")}</DialogTitle>
          <DialogDescription>{project.title}</DialogDescription>
        </DialogHeader>
        {page === null ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>{t("Project notes are unavailable")}</EmptyTitle>
              <EmptyDescription>
                {t("Reconnect to the local desktop backend and reopen this panel.")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid min-h-0 min-w-0 gap-3 overflow-auto px-4 pb-4 sm:grid-cols-[minmax(9rem,13rem)_minmax(0,1fr)] sm:px-6 sm:pb-6">
            <aside className="flex min-h-0 min-w-0 flex-col gap-2 rounded-xl border border-border/60 bg-background p-2.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={working || dirty}
                onClick={() => void create()}
              >
                <PlusIcon aria-hidden="true" />
                {t("New note")}
              </Button>
              <ul
                aria-label={t("Project notes")}
                className="max-h-44 min-w-0 overflow-auto sm:max-h-[52dvh]"
              >
                {page.notes.map((note) => (
                  <li key={note.id}>
                    <Button
                      type="button"
                      size="sm"
                      variant={draft?.id === note.id ? "secondary" : "ghost"}
                      className="w-full min-w-0 justify-start"
                      aria-current={draft?.id === note.id ? "true" : undefined}
                      disabled={working || dirty}
                      onClick={() => void choose(note.id)}
                    >
                      <span className="truncate">{note.title}</span>
                    </Button>
                  </li>
                ))}
              </ul>
              {page.nextCursor !== null ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={working}
                  onClick={() => void loadMore()}
                >
                  {t("Load more")}
                </Button>
              ) : null}
            </aside>
            <div className="flex min-w-0 flex-col gap-2">
              {draft ? (
                <ProjectNoteEditor
                  key={draft.id}
                  draft={draft}
                  canWrite
                  online
                  saving={working}
                  retryPending={pendingSave !== null}
                  onChange={(next) =>
                    changeDraft((current) => (current ? { ...current, ...next } : current))
                  }
                  onSave={() => void save()}
                />
              ) : (
                <Empty size="compact">
                  <EmptyMedia variant="icon">
                    <BookOpenIcon />
                  </EmptyMedia>
                  <EmptyHeader>
                    <EmptyTitle>{t("No note selected")}</EmptyTitle>
                    <EmptyDescription>
                      {t("Select a note or create a new one. Notes stay outside Git and chat.")}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              {draft?.conflictingRevision != null ? (
                <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/30 p-3">
                  {comparison === null ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="self-start"
                      disabled={working}
                      onClick={() => void showComparison()}
                    >
                      {t("Compare saved version")}
                    </Button>
                  ) : (
                    <>
                      <p className="text-sm font-medium">
                        {t("Saved version")}: {comparison.title}
                      </p>
                      <pre className="max-h-40 overflow-auto rounded-md bg-background p-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {comparison.markdown}
                      </pre>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => resolveComparison(false)}
                        >
                          {t("Keep draft for manual merge")}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => resolveComparison(true)}
                        >
                          {t("Use saved version")}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ) : null}
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {t("Could not complete the note action. Your open draft has not been replaced.")}
                </p>
              ) : null}
              {discard ? (
                <div
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 px-3 py-2"
                  role="alert"
                >
                  <span className="grow text-sm">{t("Discard unsaved changes?")}</span>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setDiscard(false)}>
                    {t("Keep editing")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={working}
                    onClick={() => {
                      changeDraft(() => null);
                      onClose();
                    }}
                  >
                    {t("Discard changes")}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

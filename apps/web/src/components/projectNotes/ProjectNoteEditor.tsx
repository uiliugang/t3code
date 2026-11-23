import { BookOpenIcon, LockKeyholeIcon, SaveIcon } from "lucide-react";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { useId, useRef, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { PROJECT_NOTE_MAX_BYTES } from "@t3tools/contracts";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { isDirtyNoteDraft, type NoteDraft } from "./projectNoteDraft";
import { parseProjectNotePreview } from "./projectNotePreview";

export function ProjectNoteEditor({
  draft,
  canWrite,
  online,
  saving,
  retryPending,
  onChange,
  onSave,
}: {
  readonly draft: NoteDraft;
  readonly canWrite: boolean;
  readonly online: boolean;
  readonly saving: boolean;
  readonly retryPending: boolean;
  readonly onChange: (next: Partial<Pick<NoteDraft, "title" | "markdown">>) => void;
  readonly onSave: () => void;
}) {
  const t = useUiTranslation();
  const titleId = useId();
  const bodyId = useId();
  const composing = useRef(false);
  const [preview, setPreview] = useState(false);
  const dirty = retryPending || isDirtyNoteDraft(draft);
  const tooLarge = new TextEncoder().encode(draft.markdown).length > PROJECT_NOTE_MAX_BYTES;
  const canSave =
    canWrite &&
    online &&
    !saving &&
    (retryPending ||
      (draft.conflictingRevision === null && dirty && !tooLarge && draft.title.trim().length > 0));
  const save = () => {
    if (canSave && !composing.current) onSave();
  };
  const status =
    draft.conflictingRevision !== null
      ? t("This note changed on another device. Your draft is still here.")
      : tooLarge
        ? t("Keep this note under 256 KiB.")
        : saving
          ? t("Saving…")
          : !online && dirty
            ? t("Offline draft")
            : dirty
              ? t("Unsaved changes")
              : t("Saved");
  return (
    <section
      aria-label={t("Project note")}
      className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-card text-card-foreground"
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return;
        if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) save();
        }
      }}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2 sm:px-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <BookOpenIcon className="size-4 shrink-0 text-muted-foreground" />
          {t("Project note")}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            aria-label={t("Markdown editor mode")}
            value={[preview ? "preview" : "edit"]}
            onValueChange={(next) => {
              if (next.length > 0 && !composing.current) setPreview(next.includes("preview"));
            }}
          >
            <Toggle value="edit" aria-label={t("Edit Markdown")}>
              {t("Edit")}
            </Toggle>
            <Toggle value="preview" aria-label={t("Preview Markdown")}>
              {t("Preview")}
            </Toggle>
          </ToggleGroup>
          <Button type="button" size="sm" disabled={!canSave} onClick={save}>
            <SaveIcon aria-hidden="true" />
            {t("Save")}
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-3 py-4 sm:px-5">
        <label htmlFor={titleId} className="text-xs font-medium text-muted-foreground">
          {t("Note title")}
        </label>
        <Input
          id={titleId}
          className="min-w-0 max-w-xl"
          readOnly={!canWrite}
          maxLength={160}
          value={draft.title}
          onChange={(event) => onChange({ title: event.currentTarget.value })}
        />
        {preview ? (
          <div className="chat-markdown min-h-44 min-w-0 overflow-auto rounded-lg border border-border/60 bg-background px-3 py-4 text-sm leading-6 [overflow-wrap:anywhere] [&_pre]:overflow-auto">
            {toJsxRuntime(parseProjectNotePreview(draft.markdown), {
              Fragment,
              jsx,
              jsxs,
              ignoreInvalidStyle: true,
            })}
          </div>
        ) : (
          <>
            <label htmlFor={bodyId} className="sr-only">
              {t("Markdown source")}
            </label>
            <Textarea
              id={bodyId}
              className="min-w-0"
              rows={10}
              readOnly={!canWrite}
              aria-invalid={tooLarge}
              spellCheck={false}
              value={draft.markdown}
              onChange={(event) => onChange({ markdown: event.currentTarget.value })}
            />
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground sm:px-4">
        <div className="flex items-center gap-1.5">
          <LockKeyholeIcon className="size-3" aria-hidden="true" />
          {t("Private note")}
        </div>
        <div role="status">{status}</div>
      </div>
    </section>
  );
}

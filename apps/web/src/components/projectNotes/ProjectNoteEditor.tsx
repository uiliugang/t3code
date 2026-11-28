import { LockKeyholeIcon, SaveIcon } from "lucide-react";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { useId, useRef, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { PROJECT_NOTE_MAX_BYTES } from "@t3tools/contracts";
import { useUiTranslation } from "~/hooks/useUiTranslation";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn, isMacPlatform } from "~/lib/utils";
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
  const conflicted = draft.conflictingRevision !== null;
  const canSave =
    canWrite &&
    online &&
    !saving &&
    (retryPending ||
      (draft.conflictingRevision === null && dirty && !tooLarge && draft.title.trim().length > 0));
  const save = () => {
    if (canSave && !composing.current) onSave();
  };
  // A conflict is explained by the banner under the editor, so the status line only says it is unsaved.
  const status = conflicted
    ? t("Unsaved changes")
    : tooLarge
      ? t("Keep this note under 256 KiB.")
      : saving
        ? t("Saving…")
        : !online && dirty
          ? t("Offline draft")
          : dirty
            ? t("Unsaved changes")
            : t("Saved");
  const needsAttention = conflicted || tooLarge || (!online && dirty) || retryPending;
  const saveHint = `${isMacPlatform(navigator.platform) ? "⌘" : "Ctrl"}↵`;
  return (
    <section
      aria-label={t("Project note")}
      className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-border/60"
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
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 px-3 pt-2.5 sm:px-4">
        <ToggleGroup
          aria-label={t("Markdown editor mode")}
          value={[preview ? "preview" : "edit"]}
          onValueChange={(next) => {
            if (!composing.current && next.length > 0) setPreview(next[0] === "preview");
          }}
        >
          <Toggle value="edit">{t("Edit")}</Toggle>
          <Toggle value="preview">{t("Preview")}</Toggle>
        </ToggleGroup>
        <Button type="button" size="sm" disabled={!canSave} onClick={save}>
          <SaveIcon aria-hidden="true" />
          {t("Save")}
          <span aria-hidden className="opacity-60">
            {saveHint}
          </span>
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-4 py-2 sm:px-5">
        <label htmlFor={titleId} className="sr-only">
          {t("Note title")}
        </label>
        <Input
          size="headline"
          id={titleId}
          readOnly={!canWrite}
          maxLength={160}
          placeholder={t("Untitled note")}
          value={draft.title}
          onChange={(event) => onChange({ title: event.currentTarget.value })}
        />
        <div aria-hidden className="mb-1 h-px w-full bg-border/70" />
        {preview ? (
          <div className="chat-markdown min-h-44 min-w-0 overflow-auto px-1 py-2 text-sm leading-7 [overflow-wrap:anywhere] [&_pre]:overflow-auto">
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
            <div className="rounded-md focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring">
              <Textarea
                unstyled
                id={bodyId}
                className="block w-full"
                rows={10}
                readOnly={!canWrite}
                aria-invalid={tooLarge}
                spellCheck={false}
                value={draft.markdown}
                onChange={(event) => onChange({ markdown: event.currentTarget.value })}
              />
            </div>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground sm:px-4">
        <span className="flex items-center gap-1.5">
          <LockKeyholeIcon className="size-3" aria-hidden="true" />
          {t("Private note")}
        </span>
        <span
          role="status"
          className={cn(
            "flex items-center gap-1.5",
            needsAttention && "font-medium text-warning-foreground",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-2 rounded-full",
              saving && "animate-pulse bg-info-foreground motion-reduce:animate-none",
              !saving && needsAttention && "bg-warning-foreground",
              !saving && !needsAttention && "bg-success",
            )}
          />
          {status}
        </span>
      </div>
    </section>
  );
}

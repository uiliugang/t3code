import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopedProjectKey } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import type { ComposerFileAttachment } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { m } from "../../i18n/messages";
import { randomUUID } from "../../lib/utils";
import { threadContextAttachment } from "../../lib/threadContextAttachment";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readProjects, useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { orchestrationEnvironment } from "../../state/orchestration";
import { environmentSummaries } from "../../state/presentation";
import { environmentProjects } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import {
  environmentSession,
  readEnvironmentScope,
  sessionHasScope,
  useEnvironmentScope,
} from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

const sourceAtom = Atom.make<{ readonly ref: ScopedThreadRef; readonly title: string } | null>(
  null,
).pipe(Atom.keepAlive, Atom.withLabel("thread-handoff:source"));

function isDestinationProject(project: ReturnType<typeof readProjects>[number]) {
  return project.archivedAt == null && !project.isScratch;
}

const handoffDestinationIdsAtom = Atom.make((get) => {
  const projectEnvironmentIds = new Set(
    get(environmentProjects.projectsAtom)
      .filter(isDestinationProject)
      .map(({ environmentId }) => environmentId),
  );
  return get(environmentSummaries.connectedEnvironmentIdsAtom).filter(
    (environmentId) =>
      projectEnvironmentIds.has(environmentId) &&
      sessionHasScope(
        get(environmentSession.sessionStateAtom(environmentId)),
        AuthOrchestrationOperateScope,
      ),
  );
});

export function canOpenThreadHandoff(source: EnvironmentId): boolean {
  return (
    readEnvironmentScope(source, AuthOrchestrationReadScope) &&
    appAtomRegistry.get(handoffDestinationIdsAtom).some((destination) => destination !== source)
  );
}

export function useCanOpenThreadHandoff(source: EnvironmentId | null): boolean {
  const canRead = useEnvironmentScope(source, AuthOrchestrationReadScope);
  const hasDestination = useAtomValue(
    handoffDestinationIdsAtom,
    (destinations) => source !== null && destinations.some((destination) => destination !== source),
  );
  return canRead && hasDestination;
}

export function openThreadHandoff(ref: ScopedThreadRef, title: string) {
  appAtomRegistry.set(sourceAtom, { ref, title });
}

export function ThreadHandoffDialogHost() {
  const source = useAtomValue(sourceAtom);
  return source ? (
    <ThreadHandoffDialog source={source} onClose={() => appAtomRegistry.set(sourceAtom, null)} />
  ) : null;
}

function ThreadHandoffDialog({
  source,
  onClose,
}: {
  readonly source: { readonly ref: ScopedThreadRef; readonly title: string };
  readonly onClose: () => void;
}) {
  const t = useUiTranslation();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const destinationIds = useAtomValue(handoffDestinationIdsAtom);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const destinations = environments.flatMap((environment) => {
    if (
      environment.environmentId === source.ref.environmentId ||
      !destinationIds.includes(environment.environmentId)
    )
      return [];
    const choices = projects
      .filter(
        (project) =>
          project.environmentId === environment.environmentId && isDestinationProject(project),
      )
      .map((project) => {
        const ref = scopeProjectRef(project.environmentId, project.id);
        return {
          project,
          ref,
          key: scopedProjectKey(ref),
          label: `${environment.label} · ${project.title}`,
        };
      });
    return choices.length ? [{ environment, choices }] : [];
  });
  const choices = destinations.flatMap((destination) => destination.choices);
  const [selection, setSelection] = useState<string | null>(
    choices.length === 1 ? (choices[0]?.key ?? null) : null,
  );
  const [includeTranscript, setIncludeTranscript] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadTranscript = useAtomCommand(orchestrationEnvironment.threadTranscript, {
    reportFailure: false,
  });
  const openDraft = useNewThreadHandler();
  const target = choices.find((choice) => choice.key === selection);
  const attachmentLimit = target
    ? serverConfigs.get(target.ref.environmentId)?.environment.capabilities.fileAttachments
        ?.maxUploadBytes
    : undefined;

  async function prepareDraft() {
    if (busy || !target) return;
    setBusy(true);
    setError(null);
    try {
      let attachment: ComposerFileAttachment | undefined;
      if (includeTranscript) {
        const result = await loadTranscript({
          environmentId: source.ref.environmentId,
          input: { threadId: source.ref.threadId },
        });
        if (result._tag !== "Success") {
          setError(t("Could not load the thread record. Retry or open the draft without it."));
          return;
        }
        const file = threadContextAttachment(source.ref.environmentId, result.value);
        const liveLimit = appAtomRegistry
          .get(environmentServerConfigsAtom)
          .get(target.ref.environmentId)?.environment.capabilities.fileAttachments?.maxUploadBytes;
        if (liveLimit === undefined || file.size > clampFileAttachmentUploadBytes(liveLimit)) {
          setError(
            t(
              "The thread record cannot be attached on this machine. Open the draft without it to add a summary.",
            ),
          );
          return;
        }
        attachment = {
          type: "file",
          id: randomUUID(),
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          file,
          uploadOnSend: true,
        };
      }
      if (
        !readEnvironmentScope(target.ref.environmentId, AuthOrchestrationOperateScope) ||
        !appAtomRegistry
          .get(environmentSummaries.connectedEnvironmentIdsAtom)
          .includes(target.ref.environmentId) ||
        !readProjects().some(
          (project) =>
            project.id === target.ref.projectId &&
            project.environmentId === target.ref.environmentId &&
            isDestinationProject(project),
        )
      ) {
        setError(t("The destination project is no longer available."));
        return;
      }
      const opened = await openDraft(target.ref, {
        handoff: attachment ? { attachment } : {},
        prompt: attachment
          ? t(
              'Continue work from "{title}" using the attached thread record. Check the current workspace before making changes.',
              { title: source.title },
            )
          : t('Continue work from "{title}".\n\nHandoff summary:\n', { title: source.title }),
      });
      if (opened) {
        onClose();
      } else {
        setError(t("Could not open draft."));
      }
    } catch (cause) {
      setError(thrownErrorMessage(cause, m) ?? t("Could not open draft."));
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Continue on another machine")}</DialogTitle>
          <DialogDescription>
            {t("Open a new draft. Nothing is sent and the original thread stays on this machine.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">{t("Source thread")}</p>
              <p className="wrap-anywhere text-sm font-medium">{source.title}</p>
            </div>
            <div className="space-y-1.5">
              <p id="handoff-project-label" className="text-sm font-medium">
                {t("Destination project")}
              </p>
              <Select
                value={target?.key ?? null}
                onValueChange={(key) => {
                  setSelection(key);
                  setError(null);
                }}
                disabled={busy || choices.length === 0}
              >
                <SelectTrigger aria-labelledby="handoff-project-label">
                  <SelectValue placeholder={t("Choose a project")}>{target?.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {destinations.map(({ environment, choices }) => (
                    <SelectGroup key={environment.environmentId}>
                      <SelectGroupLabel>{environment.label}</SelectGroupLabel>
                      {choices.map(({ key, project }) => (
                        <SelectItem key={key} value={key} label={project.title}>
                          <span className="min-w-0">
                            <span className="block truncate">{project.title}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {project.workspaceRoot}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={includeTranscript}
                disabled={busy}
                onCheckedChange={(checked) => {
                  setIncludeTranscript(checked);
                  setError(null);
                }}
              />
              <span>{t("Attach thread record, including tool output")}</span>
            </label>
            {choices.length === 0 ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t("No projects are available on another connected machine.")}
              </p>
            ) : null}
            {target && includeTranscript && attachmentLimit === undefined ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t(
                  "The thread record cannot be attached on this machine. Open the draft without it to add a summary.",
                )}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={!target || busy || (includeTranscript && attachmentLimit === undefined)}
            onClick={() => void prepareDraft().finally(() => setBusy(false))}
          >
            {busy ? t("Preparing draft…") : t("Open draft")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

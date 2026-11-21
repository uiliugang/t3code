import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { threadTranscriptHeader } from "@t3tools/shared/threadTranscript";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { FitSheet } from "../../components/ui/FitSheet";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import {
  removePersistedComposerAttachmentFile,
  writeComposerFileAttachment,
  type DraftComposerFileAttachment,
} from "../../lib/composerImages";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { orchestrationEnvironment } from "../../state/orchestration";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { environmentProjects } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  appendComposerDraftAttachments,
  createNewTaskDraft,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";

function availableProject(project: { archivedAt?: unknown; isScratch?: boolean } | null) {
  return project !== null && project.archivedAt == null && !project.isScratch;
}

export function ThreadHandoffSheet({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
}>) {
  const source = route.params;
  const t = useUiTranslation();
  const navigation = useNavigation();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const configs = useServerConfigs();
  const connected = useAtomValue(connectedEnvironmentIdsAtom);
  const permitted = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const destinations = environments.flatMap((environment) => {
    const { environmentId } = environment;
    if (
      environmentId === source.environmentId ||
      !connected.includes(environmentId) ||
      !permitted.has(environmentId)
    )
      return [];
    const choices = projects
      .filter((project) => project.environmentId === environmentId && availableProject(project))
      .map((project) => ({ project, key: scopedProjectKey(environmentId, project.id) }));
    return choices.length ? [{ environment, choices }] : [];
  });
  const choices = destinations.flatMap((destination) => destination.choices);
  const [selection, setSelection] = useState<string | null>(null);
  const [includeTranscript, setIncludeTranscript] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preparing = useRef(false);
  const target =
    selection === null && choices.length === 1
      ? choices[0]?.project
      : choices.find((choice) => choice.key === selection)?.project;
  const loadTranscript = useAtomCommand(orchestrationEnvironment.threadTranscript, {
    reportFailure: false,
  });
  const attachmentLimit =
    target &&
    configs.get(target.environmentId)?.environment.capabilities.fileAttachments?.maxUploadBytes;
  const attachmentUnavailable = t(
    "The thread record cannot be attached on this machine. Open the draft without it to add a summary.",
  );
  const sourceLabel = environments.find(
    (environment) => environment.environmentId === source.environmentId,
  )?.label;

  function prepareDraft() {
    if (!target || preparing.current || (includeTranscript && attachmentLimit === undefined))
      return;
    preparing.current = true;
    setBusy(true);
    setError(null);
    let attachment: DraftComposerFileAttachment | undefined;
    const openDraft = async () => {
      if (includeTranscript) {
        const result = await loadTranscript({
          environmentId: source.environmentId,
          input: { threadId: source.threadId },
        });
        if (!navigation.isFocused()) return;
        if (result._tag !== "Success") {
          setError(t("Could not load the thread record. Retry or open the draft without it."));
          return;
        }
        const transcript = result.value;
        const text =
          threadTranscriptHeader(source.environmentId, transcript) +
          transcript.items.map((item) => `${JSON.stringify(item)}\n`).join("");
        const sizeBytes = new TextEncoder().encode(text).byteLength;
        if (
          attachmentLimit === undefined ||
          sizeBytes > clampFileAttachmentUploadBytes(attachmentLimit)
        ) {
          setError(attachmentUnavailable);
          return;
        }
        const title = transcript.title.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 64) || "Thread";
        attachment = await writeComposerFileAttachment({
          text,
          sizeBytes,
          name: `${title}.jsonl`,
          mimeType: "application/x-ndjson",
        });
      }
      await waitForComposerDraftsLoaded();
      if (!navigation.isFocused()) return;
      const ref = scopeProjectRef(target.environmentId, target.id);
      if (
        !readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope) ||
        !appAtomRegistry.get(connectedEnvironmentIdsAtom).includes(target.environmentId) ||
        !availableProject(appAtomRegistry.get(environmentProjects.projectAtom(ref)))
      ) {
        setError(t("The destination project is no longer available."));
        return;
      }
      if (attachment) {
        const liveLimit = appAtomRegistry
          .get(environmentServerConfigsAtom)
          .get(target.environmentId)?.environment.capabilities.fileAttachments?.maxUploadBytes;
        if (
          liveLimit === undefined ||
          attachment.sizeBytes > clampFileAttachmentUploadBytes(liveLimit)
        ) {
          setError(attachmentUnavailable);
          return;
        }
      }
      const draftId = createNewTaskDraft(ref);
      setComposerDraftText(
        draftId,
        attachment
          ? t(
              'Continue work from "{title}" using the attached thread record. Check the current workspace before making changes.',
              { title: source.title },
            )
          : t('Continue work from "{title}".\n\nHandoff summary:\n', { title: source.title }),
      );
      if (attachment) {
        appendComposerDraftAttachments(draftId, [{ ...attachment, uploadOnSend: true }], {
          appendReference: true,
        });
        attachment = undefined;
      }
      navigation.dispatch(
        StackActions.replace("Thread", { draft: { draftId, title: target.title } }),
      );
    };
    void openDraft()
      .catch(() => {
        if (navigation.isFocused()) setError(t("Could not open draft."));
      })
      .finally(() => {
        if (attachment) void removePersistedComposerAttachmentFile(attachment.fileUri);
        preparing.current = false;
        if (navigation.isFocused()) setBusy(false);
      });
  }

  const recordLabel = t("Attach thread record, including tool output");
  return (
    <FitSheet
      header={
        <SheetHeader title={t("Continue on another machine")} onClose={() => navigation.goBack()} />
      }
      footer={
        <View className="gap-2">
          <Button
            label={busy ? t("Preparing draft…") : t("Open draft")}
            tone="primary"
            fullWidth
            loading={busy}
            disabled={!target || (includeTranscript && attachmentLimit === undefined)}
            onPress={prepareDraft}
          />
          <AppText className="text-center text-xs text-muted-foreground">
            {t("Open a new draft. Nothing is sent and the original thread stays on this machine.")}
          </AppText>
        </View>
      }
    >
      <View className="gap-1">
        <AppText className="text-xs text-muted-foreground">{t("Source thread")}</AppText>
        <AppText className="font-medium" numberOfLines={2}>
          {source.title}
          {sourceLabel ? ` · ${sourceLabel}` : ""}
        </AppText>
      </View>
      {choices.length === 0 ? (
        <AppText className="text-sm text-muted-foreground">
          {t("No projects are available on another connected machine.")}
        </AppText>
      ) : (
        destinations.map(({ environment, choices }) => (
          <View key={environment.environmentId} className="gap-1">
            <AppText className="text-xs font-medium text-muted-foreground">
              {environment.label}
            </AppText>
            {choices.map(({ project, key }) => {
              const selected = project === target;
              return (
                <Pressable
                  key={key}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, disabled: busy }}
                  disabled={busy}
                  onPress={() => {
                    setSelection(key);
                    setError(null);
                  }}
                  className={
                    selected
                      ? "min-h-12 flex-row items-center gap-3 rounded-lg bg-secondary px-3 py-2"
                      : "min-h-12 flex-row items-center gap-3 px-3 py-2"
                  }
                >
                  <SymbolView name="folder" size={16} tintColorClassName="text-muted-foreground" />
                  <View className="min-w-0 flex-1">
                    <AppText className="font-medium" numberOfLines={1}>
                      {project.title}
                    </AppText>
                    <AppText className="text-xs text-muted-foreground" numberOfLines={2}>
                      {project.workspaceRoot}
                    </AppText>
                  </View>
                  {selected ? (
                    <SymbolView name="checkmark" size={16} tintColorClassName="text-foreground" />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ))
      )}
      {choices.length > 0 ? (
        <View className="min-h-12 flex-row items-center gap-3">
          <AppText className="min-w-0 flex-1 text-sm">{recordLabel}</AppText>
          <ThemedSwitch
            accessibilityLabel={recordLabel}
            value={includeTranscript}
            disabled={busy}
            onValueChange={(value) => {
              setIncludeTranscript(value);
              setError(null);
            }}
          />
        </View>
      ) : null}
      {target && includeTranscript && attachmentLimit === undefined ? (
        <AppText className="text-sm text-muted-foreground">{attachmentUnavailable}</AppText>
      ) : null}
      {error ? (
        <AppText accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </AppText>
      ) : null}
    </FitSheet>
  );
}

import { useState } from "react";
import { Pressable, View } from "react-native";
import { ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForThreadShell } from "./threadForkNavigation";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

export function SideChatTaskControl(props: { threadRef: ScopedThreadRef; canOperate: boolean }) {
  const t = useUiTranslation();
  const structure = useQuietThreadStructure(props.threadRef);
  const projection = structure?.projection;
  const run = projection ? resolveLatestMergeBackRun(projection) : null;
  const continueSideChat = useAtomCommand(threadEnvironment.continueSideChat, {
    reportFailure: false,
  });
  const openLinkedThread = useOpenLinkedThread();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    if (!props.canOperate || !projection || !run || busy) return;
    setBusy(true);
    const thread = projection.thread;
    const targetThreadId = ThreadId.make(uuidv4());
    const result = await continueSideChat({
      environmentId: props.threadRef.environmentId,
      input: {
        sourceThreadId: thread.id,
        targetThreadId,
        runId: run.id,
        projectId: thread.projectId,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        baseRef: thread.branch ?? "HEAD",
        title: thread.title,
        creationSource: "mobile",
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      const target = { environmentId: props.threadRef.environmentId, threadId: targetThreadId };
      if (await waitForThreadShell(target)) openLinkedThread(target);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        t("Could not start an isolated task"),
        error instanceof Error ? error.message : undefined,
      );
    }
  };
  return (
    <View className="flex-row items-center gap-2 px-4 py-2">
      <SymbolView name="lock.fill" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="flex-1 text-xs text-foreground-muted">{t("Read only")}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Continue in isolated worktree")}
        disabled={!props.canOperate || !run || busy}
        accessibilityState={{ disabled: !props.canOperate || !run || busy, busy }}
        onPress={() => void start()}
        className={!props.canOperate || !run || busy ? "p-2 opacity-40" : "p-2"}
      >
        <SymbolView
          name="arrow.triangle.branch"
          size={16}
          tintColorClassName="accent-foreground-muted"
        />
      </Pressable>
    </View>
  );
}

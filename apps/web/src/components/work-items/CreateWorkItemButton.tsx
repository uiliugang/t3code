import { useAtomValue } from "@effect/atom-react";
import { lazy, Suspense, useRef, useState } from "react";
import { ClipboardPlusIcon } from "lucide-react";
import { type CommandId, type MessageId, type ScopedThreadRef } from "@t3tools/contracts";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { useQuietThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { prepareWorkItemCommandRetry } from "@t3tools/client-runtime/work-item";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

const WorkItemEditor = lazy(() =>
  import("./WorkItemsPage").then((module) => ({ default: module.WorkItemEditor })),
);

export function CreateWorkItemButton({
  threadRef,
  messageId,
  text,
}: {
  threadRef: ScopedThreadRef;
  messageId: MessageId;
  text: string;
}) {
  const t = useUiTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const retryCommands = useRef(new Map<string, CommandId>());
  const thread = useQuietThreadShell(threadRef);
  const config = useAtomValue(serverEnvironment.configValueAtom(threadRef.environmentId));
  const allowed = useAtomValue(
    serverEnvironment.mutateWorkItem.permissionAtom(threadRef.environmentId),
  );
  const mutate = useAtomCommand(serverEnvironment.mutateWorkItem, { reportFailure: false });
  if (!thread || !allowed || config?.workItems !== true || !text.trim()) return null;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t("Create task from message")}
              onClick={() => setOpen(true)}
            />
          }
        >
          <ClipboardPlusIcon />
        </TooltipTrigger>
        <TooltipPopup>{t("Create task from message")}</TooltipPopup>
      </Tooltip>
      {open ? (
        <Suspense fallback={null}>
          <WorkItemEditor
            environmentId={threadRef.environmentId}
            initialTitle={text.trim().split("\n")[0]?.slice(0, 300) ?? ""}
            initialDescription={text}
            initialSources={[{ threadId: threadRef.threadId, title: thread.title, messageId }]}
            projectId={thread.projectId}
            busy={busy}
            close={() => setOpen(false)}
            run={async (input, intent) => {
              if (pending.current) return false;
              const request = prepareWorkItemCommandRetry(input, retryCommands.current, intent);
              pending.current = true;
              setBusy(true);
              const result = await mutate({
                environmentId: threadRef.environmentId,
                input: request.input,
              }).finally(() => {
                pending.current = false;
                setBusy(false);
              });
              if (result._tag === "Failure") {
                if (!isAtomCommandInterrupted(result))
                  toastManager.add({
                    type: "error",
                    title: t("Could not create task"),
                    description: String(squashAtomCommandFailure(result)),
                  });
                return false;
              }
              retryCommands.current.delete(request.key);
              toastManager.add({ type: "success", title: t("Task created") });
              return true;
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}

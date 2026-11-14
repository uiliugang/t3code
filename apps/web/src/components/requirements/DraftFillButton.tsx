import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, WorkItemDraft } from "@t3tools/contracts";
import { BotIcon } from "lucide-react";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { Button } from "../ui/button";

export function DraftFillButton({
  environmentId,
  projectId,
  context,
  disabled,
  onDraft,
  onBusyChange,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | undefined;
  context: string;
  disabled?: boolean;
  onDraft: (draft: WorkItemDraft) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const t = useUiTranslation();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const allowed = useAtomValue(
    serverEnvironment.generateWorkItemDraft.permissionAtom(environmentId),
  );
  const generate = useAtomCommand(serverEnvironment.generateWorkItemDraft);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={
        disabled ||
        busy ||
        !allowed ||
        !projectId ||
        !context.trim() ||
        context.length > 16000 ||
        config?.workItemDraftGeneration !== true
      }
      onClick={async () => {
        if (!projectId) return;
        setBusy(true);
        onBusyChange(true);
        const result = await generate({ environmentId, input: { projectId, context } }).finally(
          () => {
            setBusy(false);
            onBusyChange(false);
          },
        );
        if (result._tag === "Success") onDraft(result.value);
      }}
    >
      <BotIcon />
      {t(busy ? "Generating draft..." : "Fill with agent")}
    </Button>
  );
}

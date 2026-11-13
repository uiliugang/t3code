import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, WorkItemDraft } from "@t3tools/contracts";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiTranslation } from "../../lib/useUiTranslation";
import { Button } from "../../components/ui/Button";
import { useEnvironmentServerConfig } from "../../state/entities";

export function DraftFillButton({
  environmentId,
  projectId,
  context,
  disabled,
  onDraft,
  onBusyChange,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  context: string;
  disabled?: boolean;
  onDraft: (draft: WorkItemDraft) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const t = useUiTranslation();
  const config = useEnvironmentServerConfig(environmentId);
  const allowed = useAtomValue(
    serverEnvironment.generateWorkItemDraft.permissionAtom(environmentId),
  );
  const generate = useAtomCommand(serverEnvironment.generateWorkItemDraft);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      label={t(busy ? "Generating draft..." : "Fill with agent")}
      icon="robot"
      loading={busy}
      disabled={
        disabled ||
        busy ||
        !allowed ||
        !context.trim() ||
        context.length > 16000 ||
        config?.workItemDraftGeneration !== true
      }
      onPress={async () => {
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
    />
  );
}

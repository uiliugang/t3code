import { useAtomValue } from "@effect/atom-react";
import type {
  ScopedThreadRef,
  WorkspaceRecoveryInput,
  WorkspaceRecoveryResult,
  WorkspaceRevisionId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { useUiTranslation } from "../../hooks/useUiTranslation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function WorkspaceRecoveryControl({
  threadRef,
  revisionId,
}: {
  threadRef: ScopedThreadRef;
  revisionId: WorkspaceRevisionId | null;
}) {
  const t = useUiTranslation();
  const allowed = useAtomValue(
    serverEnvironment.workspaceRecovery.permissionAtom(threadRef.environmentId),
  );
  const recover = useAtomCommand(serverEnvironment.workspaceRecovery, { reportFailure: true });
  const [report, setReport] = useState<WorkspaceRecoveryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const inspect = useEffectEvent(
    (target: WorkspaceRecoveryInput, environmentId: ScopedThreadRef["environmentId"]) => {
      return recover({
        environmentId,
        input: target,
      });
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Query the server's recovery journal when the panel opens or its target changes.
  useEffect(() => {
    let current = true;
    if (allowed)
      void inspect(
        { threadId: threadRef.threadId, expectedRevisionId: revisionId, action: "inspect" },
        threadRef.environmentId,
      ).then((result) => {
        if (current && result._tag === "Success") setReport(result.value);
      });
    return () => {
      current = false;
    };
  }, [allowed, threadRef.environmentId, threadRef.threadId, revisionId]);
  const run = async (action: WorkspaceRecoveryInput["action"]) => {
    setBusy(true);
    const result = await recover({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, expectedRevisionId: revisionId, action },
    }).finally(() => {
      setBusy(false);
    });
    if (result._tag === "Success") setReport(result.value);
  };
  if (!report || report.kind === "ready") return null;
  return (
    <div className="px-3 py-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={!allowed || busy}
        onClick={() => void run("inspect")}
      >
        {t("Group recovery")}
      </Button>
      <div className="flex flex-col gap-2 py-2 text-xs text-muted-foreground">
        <p>{t(report.detail)}</p>
        {report.repositories.map((repository) => (
          <p key={repository.path}>
            {repository.name}: {repository.stage}
          </p>
        ))}

        <Button
          variant="outline"
          size="sm"
          disabled={!allowed || busy}
          onClick={() =>
            void run(report.kind === "restore" ? "accept-current-files" : "retry-setup")
          }
        >
          {t(
            report.kind === "restore" ? "Accept files and reset conversation" : "Allow setup retry",
          )}
        </Button>
      </div>
    </div>
  );
}

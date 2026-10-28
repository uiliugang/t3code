import { useAtomValue } from "@effect/atom-react";
import type {
  ScopedThreadRef,
  WorkspaceRecoveryInput,
  WorkspaceRecoveryResult,
  WorkspaceRevisionId,
} from "@t3tools/contracts";
import { useState } from "react";
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
  const run = async (action: WorkspaceRecoveryInput["action"]) => {
    setBusy(true);
    try {
      const result = await recover({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, expectedRevisionId: revisionId, action },
      });
      if (result._tag === "Success") setReport(result.value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="px-3 py-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={!allowed || busy}
        onClick={() => void run("inspect")}
      >
        {t("Workspace recovery")}
      </Button>
      {report ? (
        <div className="flex flex-col gap-2 py-2 text-xs text-muted-foreground">
          <p>{t(report.detail)}</p>
          {report.repositories.map((repository) => (
            <p key={repository.path}>
              {repository.name}: {repository.stage}
            </p>
          ))}
          {report.kind !== "ready" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!allowed || busy}
              onClick={() =>
                void run(report.kind === "restore" ? "accept-current-files" : "retry-setup")
              }
            >
              {t(
                report.kind === "restore"
                  ? "Accept files and reset conversation"
                  : "Allow setup retry",
              )}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

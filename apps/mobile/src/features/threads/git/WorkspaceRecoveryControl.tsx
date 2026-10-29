import { useAtomValue } from "@effect/atom-react";
import type {
  ScopedThreadRef,
  WorkspaceRecoveryInput,
  WorkspaceRecoveryResult,
  WorkspaceRevisionId,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { AppText } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";

export function WorkspaceRecoveryControl({
  threadRef,
  revisionId,
}: {
  threadRef: ScopedThreadRef;
  revisionId: WorkspaceRevisionId | null;
}) {
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
    <View className="gap-2 px-4 py-3">
      <Button
        disabled={!allowed || busy}
        onPress={() => void run("inspect")}
        label="Workspace recovery"
      />
      {report ? (
        <>
          <AppText>{report.detail}</AppText>
          {report.repositories.map((repository) => (
            <AppText key={repository.path}>
              {repository.name}: {repository.stage}
            </AppText>
          ))}
          {report.kind !== "ready" ? (
            <Button
              disabled={!allowed || busy}
              onPress={() =>
                void run(report.kind === "restore" ? "accept-current-files" : "retry-setup")
              }
              label={
                report.kind === "restore"
                  ? "Accept files and reset conversation"
                  : "Allow setup retry"
              }
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

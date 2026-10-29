import { useAtomValue } from "@effect/atom-react";
import { projectImportFailureMessage, type EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

export function ProjectImportHistory({ environmentId }: { environmentId: EnvironmentId }) {
  const imports = useEnvironmentQuery(
    sourceControlEnvironment.projectImports({ environmentId, input: {} }),
  );
  const canRetry = useAtomValue(
    sourceControlEnvironment.retryProjectImport.permissionAtom(environmentId),
  );
  const canForget = useAtomValue(
    sourceControlEnvironment.forgetProjectImport.permissionAtom(environmentId),
  );
  const retry = useAtomCommand(sourceControlEnvironment.retryProjectImport);
  const forget = useAtomCommand(sourceControlEnvironment.forgetProjectImport);
  return (
    <>
      {imports.error ? (
        <Text className="p-4 text-sm text-danger-foreground">{imports.error}</Text>
      ) : null}
      {imports.data?.map((record) => (
        <View key={record.id} className="gap-3 border-t border-border p-4">
          <Text className="text-sm font-t3-medium text-foreground">
            {record.projects.map((project) => project.name).join(", ")} · {record.phase}
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            {record.destinationDirectory}
          </Text>
          {record.repositories.map((repository) => (
            <View key={repository.key} className="gap-1">
              <Text selectable className="text-xs text-foreground-muted">
                {repository.remoteUrl ?? "Missing clone URL"} · {repository.phase}
              </Text>
              <Text selectable className="text-xs text-foreground-muted">
                {repository.destinationPath}
              </Text>
              {repository.failure ? (
                <Text className="text-xs text-danger-foreground">
                  {projectImportFailureMessage(repository.failure)}
                </Text>
              ) : null}
              {repository.failure && repository.stagingPath ? (
                <Text selectable className="text-xs text-foreground-muted">
                  Partial checkout: {repository.stagingPath}
                </Text>
              ) : null}
            </View>
          ))}
          {record.projects
            .filter((project) => project.failure !== null)
            .map((project) => (
              <Text key={project.projectId} className="text-xs text-danger-foreground">
                {project.name}: {projectImportFailureMessage(project.failure!)}
              </Text>
            ))}
          <Button
            label="Retry failed import"
            disabled={!canRetry || record.phase === "running" || record.phase === "done"}
            onPress={() => void retry({ environmentId, input: { id: record.id } })}
          />
          <Button
            label="Forget import"
            tone="text"
            disabled={!canForget || record.phase === "running"}
            onPress={() =>
              Dialog.confirm({
                title: "Forget this import?",
                message: "Projects and cloned or partial repositories stay on disk.",
                confirmText: "Forget import",
                onConfirm: () => {
                  void forget({ environmentId, input: { id: record.id } });
                },
              })
            }
          />
        </View>
      ))}
    </>
  );
}

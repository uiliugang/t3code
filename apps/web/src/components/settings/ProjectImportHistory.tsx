import { useAtomValue } from "@effect/atom-react";
import { projectImportFailureMessage, type EnvironmentId } from "@t3tools/contracts";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { requestConfirmDialog } from "../../confirmDialog";

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
        <SettingsRow title="Could not load saved imports" description={imports.error} />
      ) : null}
      {imports.data?.map((record) => (
        <SettingsRow
          key={record.id}
          title={`${record.projects.map((project) => project.name).join(", ")} · ${record.phase}`}
          description={`${record.destinationDirectory} · ${record.repositories.filter((repository) => repository.phase === "ready").length}/${record.repositories.length} repositories ready`}
          control={
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!canRetry || record.phase === "running" || record.phase === "done"}
                onClick={() => void retry({ environmentId, input: { id: record.id } })}
              >
                Retry failed import
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!canForget || record.phase === "running"}
                onClick={async () => {
                  if (
                    await requestConfirmDialog(
                      "Forget this import? Projects and cloned or partial repositories stay on disk.",
                    )
                  )
                    await forget({ environmentId, input: { id: record.id } });
                }}
              >
                Forget import
              </Button>
            </div>
          }
        >
          <div className="space-y-2 px-4 pb-3 text-xs text-muted-foreground">
            {record.repositories.map((repository) => (
              <div key={repository.key} className="space-y-1 break-all">
                <p>
                  {repository.remoteUrl ?? "Missing clone URL"} · {repository.phase}
                </p>
                <p>{repository.destinationPath}</p>
                {repository.failure ? (
                  <p>{projectImportFailureMessage(repository.failure)}</p>
                ) : null}
                {repository.failure && repository.stagingPath ? (
                  <p>Partial checkout: {repository.stagingPath}</p>
                ) : null}
              </div>
            ))}
            {record.projects
              .filter((project) => project.failure !== null)
              .map((project) => (
                <p key={project.projectId}>
                  {project.name}: {projectImportFailureMessage(project.failure!)}
                </p>
              ))}
          </div>
        </SettingsRow>
      ))}
    </>
  );
}

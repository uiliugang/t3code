import { useAtomValue } from "@effect/atom-react";
import {
  PROJECT_FOLDER_BATCH_LIMIT,
  type EnvironmentId,
  type ProjectFolderImportResult,
} from "@t3tools/contracts";
import {
  selectProjectFolders,
  projectFolderStatus,
  type ProjectFolderSelection,
} from "@t3tools/client-runtime/operations/projects";
import {
  ensureBrowseDirectoryPath,
  getBrowseParentPath,
} from "@t3tools/client-runtime/state/projects";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { projectEnvironment } from "../../state/projects";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

export function ProjectFolderPicker({
  environmentId,
  initialPath,
}: {
  environmentId: EnvironmentId;
  initialPath: string;
}) {
  const [directory, setDirectory] = useState(initialPath);
  const [pathInput, setPathInput] = useState(initialPath);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ReadonlyArray<ProjectFolderSelection>>([]);
  const [results, setResults] = useState<ReadonlyArray<ProjectFolderImportResult>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canImport = useAtomValue(projectEnvironment.importFolders.permissionAtom(environmentId));
  const browse = useEnvironmentQuery(
    canImport
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: ensureBrowseDirectoryPath(directory) },
        })
      : null,
  );
  const entries = (browse.data?.entries ?? []).filter(
    (entry) =>
      entry.name.toLowerCase().includes(filter.toLowerCase()) &&
      (!entry.name.startsWith(".") || filter.startsWith(".")),
  );
  const paths = entries
    .slice(page * PROJECT_FOLDER_BATCH_LIMIT, (page + 1) * PROJECT_FOLDER_BATCH_LIMIT)
    .map((entry) => entry.fullPath);
  const inspect = useEnvironmentQuery(
    canImport && paths.length > 0
      ? projectEnvironment.inspectFolders({ environmentId, input: { paths } })
      : null,
  );
  const importFolders = useAtomCommand(projectEnvironment.importFolders, { reportFailure: false });
  const parent = getBrowseParentPath(
    ensureBrowseDirectoryPath(browse.data?.parentPath ?? directory),
  );
  const navigate = (value: string) => {
    setDirectory(value);
    setPathInput(value);
    setFilter("");
    setPage(0);
  };
  const submit = async () => {
    if (busy || !canImport || selected.length === 0) return;
    setBusy(true);
    setError(null);
    const completed: ProjectFolderImportResult[] = [];
    for (let offset = 0; offset < selected.length; offset += PROJECT_FOLDER_BATCH_LIMIT) {
      const response = await importFolders({
        environmentId,
        input: {
          folders: selected
            .slice(offset, offset + PROJECT_FOLDER_BATCH_LIMIT)
            .map((entry) => ({ path: entry.path, allowSameRepository: entry.allowSameRepository })),
        },
      });
      if (response._tag === "Failure") {
        setError("Import interrupted. Retry remaining folders.");
        break;
      }
      completed.push(...response.value);
    }
    setResults(completed);
    const done = new Set(
      completed.filter((entry) => entry.status !== "failed").map((entry) => entry.path),
    );
    setSelected((previous) => previous.filter((entry) => !done.has(entry.path)));
    inspect.refresh();
    setBusy(false);
  };
  return (
    <View className="gap-3">
      {!canImport ? <ErrorBanner message="This connection cannot import folders." /> : null}
      {(error ?? browse.error ?? inspect.error) ? (
        <ErrorBanner message={(error ?? browse.error ?? inspect.error)!} />
      ) : null}
      <AppTextInput
        accessibilityLabel="Folder path"
        value={pathInput}
        onChangeText={setPathInput}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={() => {
          if (pathInput.trim()) navigate(pathInput.trim());
        }}
        className="rounded-lg border border-border px-3 py-3 text-foreground"
      />
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Parent folder"
          icon="arrow.left"
          disabled={!parent || busy}
          onPress={() => {
            if (parent) navigate(parent);
          }}
        />
        <Button
          label="Open folder"
          icon="folder"
          disabled={busy || !pathInput.trim()}
          onPress={() => navigate(pathInput.trim())}
        />
      </View>
      <AppTextInput
        accessibilityLabel="Filter folders"
        placeholder="Filter folders"
        value={filter}
        editable={!busy}
        onChangeText={(value) => {
          setFilter(value);
          setPage(0);
        }}
        className="rounded-lg border border-border px-3 py-3 text-foreground"
      />
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Select available"
          disabled={busy || inspect.isPending}
          onPress={() =>
            setSelected((previous) => selectProjectFolders(previous, inspect.data ?? []))
          }
        />
        <Button label="Clear" disabled={busy} onPress={() => setSelected([])} />
      </View>
      {browse.isPending || inspect.isPending ? (
        <Text>Checking folders...</Text>
      ) : (
        (inspect.data ?? []).map((candidate) => {
          const checked = selected.some((entry) => entry.workspaceRoot === candidate.workspaceRoot);
          const added =
            candidate.existingProjectId ||
            results.some(
              (entry) =>
                entry.path === candidate.path &&
                (entry.status === "created" || entry.status === "existing"),
            );
          return (
            <View
              key={candidate.path}
              className="flex-row items-center gap-2 border-b border-border py-3"
            >
              <Pressable
                accessibilityRole="checkbox"
                accessibilityLabel={`Select folder ${candidate.title}`}
                accessibilityState={{
                  checked,
                  disabled: busy || Boolean(added) || Boolean(candidate.error),
                }}
                disabled={busy || Boolean(added) || Boolean(candidate.error)}
                className="min-h-12 flex-1 justify-center"
                onPress={() =>
                  setSelected((previous) =>
                    checked
                      ? previous.filter((entry) => entry.workspaceRoot !== candidate.workspaceRoot)
                      : selectProjectFolders(previous, [candidate], true),
                  )
                }
              >
                <View className="flex-row items-center gap-2">
                  <SymbolView
                    name={checked ? "checkmark.circle.fill" : "circle"}
                    size={20}
                    tintColorClassName="accent-icon"
                  />
                  <Text className="flex-1 text-base text-foreground">{candidate.title}</Text>
                </View>
                <Text className="text-xs text-foreground-muted">
                  {added ? "Already added" : projectFolderStatus(candidate)}
                </Text>
              </Pressable>
              <Button
                label="Open"
                accessibilityLabel={`Open folder ${candidate.title}`}
                icon="chevron.right"
                tone="text"
                disabled={busy}
                onPress={() => navigate(candidate.path)}
              />
            </View>
          );
        })
      )}
      {entries.length > PROJECT_FOLDER_BATCH_LIMIT ? (
        <View className="flex-row flex-wrap items-center gap-2">
          <Button
            label="Previous page"
            disabled={page === 0 || busy}
            onPress={() => setPage(page - 1)}
          />
          <Text>
            {page + 1} / {Math.ceil(entries.length / PROJECT_FOLDER_BATCH_LIMIT)}
          </Text>
          <Button
            label="Next page"
            disabled={(page + 1) * PROJECT_FOLDER_BATCH_LIMIT >= entries.length || busy}
            onPress={() => setPage(page + 1)}
          />
        </View>
      ) : null}
      <Text>Selected: {selected.length}</Text>
      {selected.map((entry) => (
        <Pressable
          key={entry.workspaceRoot}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${entry.title}`}
          disabled={busy}
          onPress={() =>
            setSelected((previous) =>
              previous.filter((candidate) => candidate.workspaceRoot !== entry.workspaceRoot),
            )
          }
        >
          <Text className="py-2 text-xs text-foreground-muted">{entry.path}</Text>
        </Pressable>
      ))}
      {results.length > 0 ? (
        <Text>
          Imported: {results.filter((entry) => entry.status === "created").length}, skipped:{" "}
          {
            results.filter((entry) => entry.status === "existing" || entry.status === "repository")
              .length
          }
          , failed: {results.filter((entry) => entry.status === "failed").length}
        </Text>
      ) : null}
      {results
        .filter((entry) => entry.status === "failed")
        .map((entry) => (
          <ErrorBanner key={entry.path} message={`${entry.path}: ${entry.error}`} />
        ))}
      <Button
        label={`${results.some((entry) => entry.status === "failed") || error ? "Retry remaining" : "Import projects"} (${selected.length})`}
        icon="folder.badge.plus"
        tone="primary"
        loading={busy}
        disabled={!canImport || selected.length === 0}
        onPress={() => void submit()}
      />
    </View>
  );
}
